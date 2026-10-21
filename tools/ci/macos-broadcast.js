import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

assert.equal(process.platform, 'darwin');
const mode = process.argv[2]; assert.ok(['setup', 'cleanup'].includes(mode));
const root = process.env.MEDIAMANAGER_VALIDATION_OUTPUT_ROOT;
assert.ok(path.isAbsolute(root ?? ''));
const directory = path.join(root, 'provisioning'), filename = path.join(directory, 'broadcast-route.json');
await mkdir(directory, { recursive: true });
const sha = value => createHash('sha256').update(value).digest('hex');
const command = (executable, args) => execFileSync(executable, args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
const route = () => command('/sbin/route', ['-n', 'get', '255.255.255.255']);
const interfaces = () => command('/sbin/ifconfig', ['-a']);
const routes = () => command('/usr/sbin/netstat', ['-rn', '-f', 'inet']);
const defaultRoute = () => command('/sbin/route', ['-n', 'get', 'default']);
const errorRecord = error => ({ name: error.name, message: error.message, stack: error.stack, status: error.status,
  code: error.code, stdout: error.stdout?.toString(), stderr: error.stderr?.toString(), errors: error.errors?.map(errorRecord) });
const defaultIdentity = value => ({ gateway: /^\s*gateway: (.+)$/mu.exec(value)?.[1], interface: /^\s*interface: (.+)$/mu.exec(value)?.[1] });
function ipv4Range(value) {
  if (value === 'default') return null;
  const [address, bits] = value.split('/'), parts = address.split('.');
  if (parts.length > 4 || parts.some(part => !/^\d+$/u.test(part) || Number(part) > 255)) return null;
  const prefix = bits === undefined ? parts.length * 8 : Number(bits);
  if (!Number.isInteger(prefix) || prefix < 1 || prefix > 32) return null;
  const number = Array.from({ length: 4 }, (_, index) => Number(parts[index] ?? 0)).reduce((sum, octet) => sum * 256 + octet, 0);
  const span = 2 ** (32 - prefix), first = Math.floor(number / span) * span;
  return [first, first + span - 1];
}

// Darwin route(8) cannot set RTF_BROADCAST or faithfully replay an old route.
// The generated helper uses PF_ROUTE only for INADDR_BROADCAST and saves the
// RTM_GET addresses, flags and metrics before mutation. There is no arbitrary
// destination, default-route, flush or packet-injection operation.
// https://github.com/apple-oss-distributions/network_cmds/blob/main/route.tproj/route.c
// https://github.com/apple-oss-distributions/xnu/blob/main/bsd/netinet/ip_output.c
// https://github.com/apple-oss-distributions/xnu/blob/main/tests/net_test_lib.c
const routeSource = String.raw`
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/ioctl.h>
#include <net/if.h>
#include <net/if_dl.h>
#include <net/if_types.h>
#include <net/route.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <err.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef union { struct rt_msghdr header; unsigned char bytes[8192]; } Message;
static int sequence;
static size_t padded(size_t size) { return size ? ((size + 3u) & ~3u) : 4u; }
static struct sockaddr *address(Message *message, unsigned bit) {
  size_t offset = sizeof(struct rt_msghdr);
  for (unsigned index = 0; index < RTAX_MAX; index++) {
    if (!(message->header.rtm_addrs & (1u << index))) continue;
    if (offset + 2 > message->header.rtm_msglen) errx(1, "Invalid route address header");
    struct sockaddr *value = (struct sockaddr *)(message->bytes + offset);
    if (offset + padded(value->sa_len) > message->header.rtm_msglen) errx(1, "Invalid route address length");
    if ((1u << index) == bit) return value;
    offset += padded(value->sa_len);
  }
  return NULL;
}
static int exact(Message *message) {
  struct sockaddr *value = address(message, RTA_DST);
  return value && value->sa_family == AF_INET && value->sa_len >= sizeof(struct sockaddr_in)
    && ((struct sockaddr_in *)value)->sin_addr.s_addr == INADDR_BROADCAST;
}
static void require_exact(Message *message) { if (!exact(message)) errx(1, "Refusing to mutate any route except 255.255.255.255"); }
static void append(Message *message, unsigned bit, const void *value, size_t length) {
  if (message->header.rtm_msglen + padded(length) > sizeof(*message)) errx(1, "Route message exceeds storage");
  memcpy(message->bytes + message->header.rtm_msglen, value, length);
  message->header.rtm_msglen += padded(length); message->header.rtm_addrs |= bit;
}
static int exchange(int socket_fd, Message *request, Message *reply, int type) {
  request->header.rtm_type = type; request->header.rtm_version = RTM_VERSION;
  request->header.rtm_pid = getpid(); request->header.rtm_seq = ++sequence; request->header.rtm_errno = 0;
  ssize_t written = write(socket_fd, request->bytes, request->header.rtm_msglen);
  if (written < 0) return errno;
  if (written != request->header.rtm_msglen) return EIO;
  for (;;) {
    ssize_t length = read(socket_fd, reply->bytes, sizeof(*reply));
    if (length < 0) return errno;
    if ((size_t)length < sizeof(struct rt_msghdr)) return EIO;
    if (reply->header.rtm_pid != getpid() || reply->header.rtm_seq != sequence) continue;
    if (reply->header.rtm_msglen > length) return EIO;
    return reply->header.rtm_errno;
  }
}
static int query(int socket_fd, Message *reply) {
  Message request = {0}; request.header.rtm_msglen = sizeof(struct rt_msghdr);
  struct sockaddr_in destination = { .sin_len = sizeof(destination), .sin_family = AF_INET, .sin_addr.s_addr = INADDR_BROADCAST };
  struct sockaddr_dl interface = { .sdl_len = sizeof(interface), .sdl_family = AF_LINK };
  append(&request, RTA_DST, &destination, sizeof(destination)); append(&request, RTA_IFP, &interface, sizeof(interface));
  int error = exchange(socket_fd, &request, reply, RTM_GET);
  if (error == ESRCH || error == ENETUNREACH) { memset(reply, 0, sizeof(*reply)); return 0; }
  if (error) { errno = error; err(1, "RTM_GET limited broadcast"); }
  return exact(reply);
}
static int same_identity(Message *left, Message *right) {
  if (!exact(left) || !exact(right)) return 0;
  if (left->header.rtm_index != right->header.rtm_index
    || (left->header.rtm_flags & ~RTF_DONE) != (right->header.rtm_flags & ~RTF_DONE)) return 0;
  struct rt_metrics one_metric = left->header.rtm_rmx, two_metric = right->header.rtm_rmx;
  if (one_metric.rmx_locks != two_metric.rmx_locks || one_metric.rmx_mtu != two_metric.rmx_mtu
    || one_metric.rmx_hopcount != two_metric.rmx_hopcount || one_metric.rmx_expire != two_metric.rmx_expire
    || one_metric.rmx_recvpipe != two_metric.rmx_recvpipe || one_metric.rmx_sendpipe != two_metric.rmx_sendpipe
    || one_metric.rmx_ssthresh != two_metric.rmx_ssthresh || one_metric.rmx_rtt != two_metric.rmx_rtt
    || one_metric.rmx_rttvar != two_metric.rmx_rttvar) return 0;
  for (unsigned index = 0; index < RTAX_MAX; index++) {
    struct sockaddr *one = address(left, 1u << index), *two = address(right, 1u << index);
    if ((!one) != (!two)) return 0;
    if (one && (one->sa_len != two->sa_len || memcmp(one, two, one->sa_len))) return 0;
  }
  return 1;
}
static Message load(const char *filename) {
  Message value = {0}; int file = open(filename, O_RDONLY | O_NOFOLLOW); if (file < 0) err(1, "Read saved route");
  ssize_t length = read(file, value.bytes, sizeof(value)); if (length < 0) err(1, "Read route bytes"); close(file);
  if (!length) return value;
  if ((size_t)length < sizeof(struct rt_msghdr) || value.header.rtm_msglen != length) errx(1, "Invalid saved route");
  require_exact(&value); return value;
}
static void apply(int socket_fd, Message *value, int type) {
  Message request = *value, reply = {0}; require_exact(&request); request.header.rtm_flags &= ~RTF_DONE;
  if (type != RTM_ADD) request.header.rtm_inits = 0;
  int error = exchange(socket_fd, &request, &reply, type);
  if (error) { errno = error; err(1, type == RTM_ADD ? "RTM_ADD limited broadcast" : "RTM_DELETE limited broadcast"); }
}
int main(int argc, char **argv) {
  if (argc != 5 || (strcmp(argv[1], "snapshot") && strcmp(argv[1], "install") && strcmp(argv[1], "restore"))) errx(1, "Invalid owned route operation");
  if (geteuid() != 0) errx(1, "Owned route operations require root");
  int socket_fd = socket(PF_ROUTE, SOCK_RAW, 0); if (socket_fd < 0) err(1, "PF_ROUTE socket");
  struct timeval timeout = { .tv_sec = 5 }; if (setsockopt(socket_fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout))) err(1, "PF_ROUTE timeout");
  Message current = {0}; int has_current = query(socket_fd, &current);
  if (!strcmp(argv[1], "snapshot")) {
    int file = open(argv[2], O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0644); if (file < 0) err(1, "Create original route receipt");
    if (has_current && write(file, current.bytes, current.header.rtm_msglen) != current.header.rtm_msglen) err(1, "Save original route bytes");
    if (close(file)) err(1, "Close original route receipt");
    printf("{\"exactRouteExisted\":%s,\"interfaceIndex\":%u,\"flags\":%d,\"expiryEpochSeconds\":%lld}\n", has_current ? "true" : "false", current.header.rtm_index, current.header.rtm_flags, (long long)current.header.rtm_rmx.rmx_expire);
    close(socket_fd); return 0;
  }
  Message original = load(argv[2]); int has_original = exact(&original);
  unsigned owned_index = if_nametoindex(argv[3]);
  if (!strcmp(argv[1], "install")) {
    if (!owned_index || strncmp(argv[3], "feth", 4)) errx(1, "The replacement must use the created feth interface");
    if (has_current != has_original || (has_original && !same_identity(&current, &original))) errx(1, "Limited broadcast route changed after capture");
    Message replacement = {0}; replacement.header.rtm_msglen = sizeof(struct rt_msghdr);
    replacement.header.rtm_flags = RTF_UP | RTF_HOST | RTF_STATIC | RTF_BROADCAST; replacement.header.rtm_index = owned_index;
    int control = socket(AF_INET, SOCK_DGRAM, 0); if (control < 0) err(1, "Interface MTU socket");
    struct ifreq link = {0}; strlcpy(link.ifr_name, argv[3], sizeof(link.ifr_name));
    if (ioctl(control, SIOCGIFMTU, &link)) err(1, "Read owned interface MTU"); close(control);
    if (link.ifr_mtu <= 0) errx(1, "Owned interface has no valid MTU");
    replacement.header.rtm_inits = RTV_MTU; replacement.header.rtm_rmx.rmx_mtu = link.ifr_mtu;
    struct sockaddr_in destination = { .sin_len = sizeof(destination), .sin_family = AF_INET, .sin_addr.s_addr = INADDR_BROADCAST };
    struct sockaddr_dl gateway = { .sdl_len = sizeof(gateway), .sdl_family = AF_LINK, .sdl_index = owned_index, .sdl_type = IFT_ETHER, .sdl_alen = 6 };
    memset(LLADDR(&gateway), 0xff, 6);
    struct sockaddr_dl interface = { .sdl_len = sizeof(interface), .sdl_family = AF_LINK, .sdl_index = owned_index };
    struct sockaddr_in source = { .sin_len = sizeof(source), .sin_family = AF_INET };
    if (inet_pton(AF_INET, argv[4], &source.sin_addr) != 1) errx(1, "Invalid owned interface address");
    append(&replacement, RTA_DST, &destination, sizeof(destination)); append(&replacement, RTA_GATEWAY, &gateway, sizeof(gateway));
    append(&replacement, RTA_IFP, &interface, sizeof(interface)); append(&replacement, RTA_IFA, &source, sizeof(source));
    if (has_original) apply(socket_fd, &original, RTM_DELETE);
    apply(socket_fd, &replacement, RTM_ADD);
    if (!query(socket_fd, &current) || current.header.rtm_index != owned_index || !(current.header.rtm_flags & RTF_BROADCAST)) errx(1, "Installed route did not retain the owned broadcast interface");
    if (current.header.rtm_rmx.rmx_mtu != (unsigned)link.ifr_mtu) errx(1, "Installed route changed the owned interface MTU");
    printf("{\"installed\":true,\"interfaceIndex\":%u,\"flags\":%d,\"mtu\":%u}\n", current.header.rtm_index, current.header.rtm_flags, current.header.rtm_rmx.rmx_mtu);
  } else {
    if (has_current && has_original && same_identity(&current, &original)) {
      printf("{\"restored\":true,\"alreadyOriginal\":true}\n"); close(socket_fd); return 0;
    }
    if (has_current) {
      if (!owned_index || current.header.rtm_index != owned_index) errx(1, "Refusing to delete a limited broadcast route owned by another interface");
      apply(socket_fd, &current, RTM_DELETE);
    }
    if (has_original) {
      // GET carries original metrics, including absolute expiry. Replay those
      // only for the original route; a new route starts from its real link MTU.
      original.header.rtm_inits = RTV_MTU | RTV_HOPCOUNT | RTV_EXPIRE | RTV_RPIPE | RTV_SPIPE | RTV_SSTHRESH | RTV_RTT | RTV_RTTVAR;
      apply(socket_fd, &original, RTM_ADD);
    }
    has_current = query(socket_fd, &current);
    if (has_current != has_original || (has_original && !same_identity(&current, &original))) errx(1, "Original route identity was not restored");
    printf("{\"restored\":true,\"exactRouteExisted\":%s,\"interfaceIndex\":%u}\n", has_current ? "true" : "false", current.header.rtm_index);
  }
  close(socket_fd); return 0;
}
`;

const helper = path.join(directory, 'broadcast-route-owner'), savedRoute = path.join(directory, 'broadcast-route-original.bin');
let record = { schemaVersion: 2, mode, at: new Date().toISOString(), createdInterfaces: [], operations: [],
  nativeDiscoveryExecutedByThisPrecheck: false, nativeDiscoveryStillRequired: true };
let interrupted, interrupt, restoring;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  interrupted = Object.assign(new Error('Broadcast setup interrupted by ' + signal), { signal }); interrupt?.(interrupted);
});
const publish = async () => {
  const pending = filename + '.pending'; await writeFile(pending, JSON.stringify(record, null, 2) + '\n'); await rename(pending, filename);
};
async function mutate(executable, args, { cleanup = false, onSuccess } = {}) {
  if (interrupted && !cleanup) throw interrupted;
  const entry = { executable, args, requestedAt: new Date().toISOString() }; record.operations.push(entry); await publish();
  if (interrupted && !cleanup) throw interrupted;
  try {
    const result = command(executable, args); entry.stdout = result; entry.completedAt = new Date().toISOString(); onSuccess?.(); await publish();
    if (interrupted && !cleanup) throw interrupted; return result;
  } catch (error) { entry.error = errorRecord(error); await publish(); throw error; }
}
function restore() {
  return restoring ??= (async () => {
    const failures = [];
    if (record.replacementRequested && !record.routeRestored) {
      try {
        assert.equal(sha(await readFile(helper)), record.helperSha256, 'The owned routing helper changed before cleanup.');
        assert.equal(sha(await readFile(savedRoute)), record.originalRouteSha256, 'The captured route changed before cleanup.');
        record.restoration = JSON.parse(await mutate('/usr/bin/sudo', [helper, 'restore', savedRoute, record.interface, record.address], { cleanup: true }));
        record.routeRestored = true; record.routeAfterRestore = route(); await publish();
      } catch (error) { failures.push(error); }
    }
    // Preserve interfaces if restoring the old route failed: a still-live owned
    // route must not lose the interface needed for an explicit cleanup retry.
    if (!record.replacementRequested || record.routeRestored) for (const name of [...record.createdInterfaces].reverse()) {
      if ((record.destroyedInterfaces ?? []).includes(name)) continue;
      try {
        await mutate('/usr/bin/sudo', ['/sbin/ifconfig', name, 'destroy'], { cleanup: true, onSuccess: () => (record.destroyedInterfaces ??= []).push(name) });
      } catch (error) { failures.push(error); }
    }
    record.cleanupInterfaces = interfaces(); record.cleanupRoutes = routes(); record.defaultRouteAfter = defaultRoute();
    if (record.defaultRoute) {
      assert.deepEqual(defaultIdentity(record.defaultRouteAfter), defaultIdentity(record.defaultRoute), 'The IPv4 default route changed.');
    }
    for (const name of record.destroyedInterfaces ?? []) assert.ok(!record.cleanupInterfaces.split('\n').some(line => line.startsWith(name + ':')), 'An owned feth interface remained after destroy.');
    record.cleanupCompleted = !failures.length; record.cleanedAt = new Date().toISOString(); await publish();
    if (failures.length) throw new AggregateError(failures, 'The owned broadcast topology could not be fully restored.');
  })();
}
if (mode === 'cleanup') {
  try { record = JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') process.exit(0); throw error; }
  assert.equal(record.schemaVersion, 2, 'Cleanup requires the corresponding owned-topology receipt.');
  try { await restore(); }
  catch (error) { record.cleanupError = errorRecord(error); await publish(); throw error; }
  process.exit(0);
}

async function verifyPackets() {
  const receiver = dgram.createSocket('udp4'), sender = dgram.createSocket('udp4');
  let timeout;
  try {
    const received = Promise.withResolvers(), returned = Promise.withResolvers();
    void received.promise.catch(() => {}); void returned.promise.catch(() => {});
    const fail = error => { received.reject(error); returned.reject(error); }; interrupt = fail;
    receiver.on('error', fail); sender.on('error', fail);
    const nonce = randomBytes(32), reply = Buffer.concat([Buffer.from('actual UDP reply:'), nonce]);
    receiver.on('message', (bytes, remote) => {
      if (!bytes.equals(nonce)) return;
      (record.precheckReceipts ??= []).push({ bytesBase64: bytes.toString('base64'), remote });
      received.resolve({ bytes, remote }); receiver.send(reply, remote.port, remote.address, error => { if (error) fail(error); });
    });
    sender.on('message', (bytes, remote) => { if (bytes.equals(reply)) returned.resolve({ bytes, remote }); });
    const bind = (socket, port) => new Promise((resolve, reject) => { socket.once('error', reject); socket.bind(port, '0.0.0.0', resolve); });
    await bind(receiver, 65001); await bind(sender, 0); sender.setBroadcast(true);
    timeout = setTimeout(() => fail(new Error('The real limited-broadcast UDP exchange did not complete.')), 5000);
    await new Promise((resolve, reject) => sender.send(nonce, 65001, '255.255.255.255', error => error ? reject(error) : resolve()));
    const actual = await received.promise, response = await returned.promise;
    assert.deepEqual(actual.bytes, nonce); assert.deepEqual(response.bytes, reply);
    record.packet = { destination: '255.255.255.255', destinationPort: 65001, receiver: receiver.address(), sender: sender.address(),
      remote: actual.remote, replyRemote: response.remote, sentBase64: nonce.toString('base64'), receivedBase64: actual.bytes.toString('base64'),
      replySentBase64: reply.toString('base64'), replyReceivedBase64: response.bytes.toString('base64') };
  } finally {
    interrupt = undefined; clearTimeout(timeout);
    await Promise.all([receiver, sender].map(socket => new Promise((resolve, reject) => {
      try { socket.close(resolve); }
      catch (error) { if (error.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING') resolve(); else reject(error); }
    })));
    record.precheckSocketsClosed = true;
  }
}

let failure;
try {
  record.interfacesBefore = interfaces(); record.routesBefore = routes(); record.defaultRoute = defaultRoute(); record.routeBefore = route();
  const existingNames = new Set([...record.interfacesBefore.matchAll(/^(\S+): /gmu)].map(match => match[1]));
  const pair = Array.from({ length: 128 }, (_, index) => ['feth' + (200 + index * 2), 'feth' + (201 + index * 2)])
    .find(names => names.every(name => !existingNames.has(name)));
  assert.ok(pair, 'An unused owned feth interface pair is required.');
  // This /30 is confined to the owned peer pair. No DHCP service, forwarding,
  // default gateway, physical NIC or firewall is changed.
  const occupiedRanges = record.routesBefore.split('\n').map(line => ipv4Range(line.trim().split(/\s+/u)[0])).filter(Boolean);
  const subnet = Array.from({ length: 128 }, (_, index) => 64 + index).find(value => {
    const candidate = ipv4Range('198.19.' + value + '.0/30');
    return occupiedRanges.every(range => candidate[1] < range[0] || candidate[0] > range[1]);
  });
  assert.notEqual(subnet, undefined, 'An unused isolated /30 is required.');
  record.interface = pair[0]; record.peer = pair[1]; record.address = '198.19.' + subnet + '.1'; record.peerAddress = '198.19.' + subnet + '.2';
  const sourcePath = path.join(directory, 'broadcast-route-owner.c'); await writeFile(sourcePath, routeSource, { flag: 'wx' });
  record.helperSourceSha256 = sha(Buffer.from(routeSource)); record.compiler = command('/usr/bin/clang', ['--version']);
  await mutate('/usr/bin/clang', ['-std=c11', '-Wall', '-Wextra', '-O2', sourcePath, '-o', helper]); record.helperSha256 = sha(await readFile(helper)); await publish();
  record.original = JSON.parse(await mutate('/usr/bin/sudo', [helper, 'snapshot', savedRoute, record.interface, record.address]));
  record.originalRouteSha256 = sha(await readFile(savedRoute));
  for (const name of pair) {
    await mutate('/usr/bin/sudo', ['/sbin/ifconfig', name, 'create'], { onSuccess: () => record.createdInterfaces.push(name) });
  }
  await mutate('/usr/bin/sudo', ['/sbin/ifconfig', pair[0], 'peer', pair[1]]);
  await mutate('/usr/bin/sudo', ['/sbin/ifconfig', pair[0], 'inet', record.address, 'netmask', '255.255.255.252', 'up']);
  await mutate('/usr/bin/sudo', ['/sbin/ifconfig', pair[1], 'inet', record.peerAddress, 'netmask', '255.255.255.252', 'up']);
  record.topology = pair.map(name => command('/sbin/ifconfig', [name]));
  for (const description of record.topology) {
    assert.match(description, /<[^>]*\bBROADCAST\b[^>]*>/u); assert.match(description, /\bstatus: active\b/u);
  }
  record.replacementRequested = true; await publish();
  record.installation = JSON.parse(await mutate('/usr/bin/sudo', [helper, 'install', savedRoute, record.interface, record.address]));
  record.routeAfter = route(); record.routesAfter = routes();
  record.defaultRouteAfterSetup = defaultRoute();
  assert.deepEqual(defaultIdentity(record.defaultRouteAfterSetup), defaultIdentity(record.defaultRoute), 'Broadcast setup changed the default route.');
  assert.match(record.routeAfter, /^\s*destination: 255\.255\.255\.255\s*$/mu);
  assert.equal(/^\s*interface: (\S+)\s*$/mu.exec(record.routeAfter)?.[1], record.interface);
  assert.match(record.routeAfter, /flags: <[^>]*\bBROADCAST\b[^>]*>/u);
  await verifyPackets(); if (interrupted) throw interrupted; record.verified = true;
} catch (error) { failure = error; record.error = errorRecord(error); }
finally {
  if (failure || interrupted) {
    try { await restore(); } catch (cleanupError) { record.cleanupError = errorRecord(cleanupError); failure = new AggregateError([failure ?? interrupted, cleanupError], 'Broadcast setup and restoration failed.'); }
  }
  await publish();
}
// A signal delivered while the final receipt write was pending still restores
// the topology before this process reports interruption to the runner.
if (interrupted && !restoring) {
  try { await restore(); } catch (cleanupError) { record.cleanupError = errorRecord(cleanupError); failure = cleanupError; }
  await publish();
}
if (failure || interrupted) throw failure ?? interrupted;
