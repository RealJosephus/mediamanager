import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import dgram from 'node:dgram';
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
#include <limits.h>
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
static void owned_path(char *output, size_t size, const char *base, const char *suffix) {
  int length = snprintf(output, size, "%s%s", base, suffix);
  if (length < 0 || (size_t)length >= size) errx(1, "Owned receipt path exceeds storage");
}
static void sync_directory(const char *filename) {
  char directory[PATH_MAX]; strlcpy(directory, filename, sizeof(directory)); char *slash = strrchr(directory, '/');
  if (!slash || slash == directory) errx(1, "Receipt must remain inside its owned provisioning directory"); *slash = 0;
  int file = open(directory, O_RDONLY | O_DIRECTORY); if (file < 0) err(1, "Open receipt directory");
  if (fsync(file)) err(1, "Sync receipt directory"); if (close(file)) err(1, "Close receipt directory");
}
static FILE *pending_receipt(const char *filename, char *temporary, size_t size) {
  char suffix[64]; snprintf(suffix, sizeof(suffix), ".pending-%d", getpid()); owned_path(temporary, size, filename, suffix);
  int file = open(temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0644); if (file < 0) err(1, "Create exclusive receipt");
  FILE *output = fdopen(file, "w"); if (!output) err(1, "Open receipt stream"); return output;
}
static void publish_receipt(FILE *output, const char *temporary, const char *filename, int replace) {
  if (fflush(output) || fsync(fileno(output)) || fclose(output)) err(1, "Sync complete receipt");
  if (replace) { if (rename(temporary, filename)) err(1, "Publish mutation state"); }
  else { if (link(temporary, filename)) err(1, "Publish exclusive observation"); if (unlink(temporary)) err(1, "Remove observation temporary link"); }
  sync_directory(filename);
}
static void describe(FILE *output, Message *message) {
  if (!message->header.rtm_msglen) { fputs("null", output); return; }
  struct rt_metrics value = message->header.rtm_rmx;
  fprintf(output, "{\"exact\":%s,\"interfaceIndex\":%u,\"flags\":%d,\"flagsWithoutDone\":%d,\"addressMask\":%d,\"metrics\":{"
    "\"locks\":%llu,\"mtu\":%llu,\"hopcount\":%llu,\"expiryEpochSeconds\":%lld,\"recvpipe\":%llu,\"sendpipe\":%llu,\"ssthresh\":%llu,\"rtt\":%llu,\"rttvar\":%llu},\"addresses\":{",
    exact(message) ? "true" : "false", message->header.rtm_index, message->header.rtm_flags, message->header.rtm_flags & ~RTF_DONE, message->header.rtm_addrs,
    (unsigned long long)value.rmx_locks, (unsigned long long)value.rmx_mtu, (unsigned long long)value.rmx_hopcount, (long long)value.rmx_expire,
    (unsigned long long)value.rmx_recvpipe, (unsigned long long)value.rmx_sendpipe, (unsigned long long)value.rmx_ssthresh,
    (unsigned long long)value.rmx_rtt, (unsigned long long)value.rmx_rttvar);
  int comma = 0;
  for (unsigned index = 0; index < RTAX_MAX; index++) {
    struct sockaddr *value = address(message, 1u << index); if (!value) continue;
    fprintf(output, "%s\"%u\":{\"length\":%u,\"family\":%u,\"hex\":\"", comma ? "," : "", index, value->sa_len, value->sa_family);
    const unsigned char *bytes = (const unsigned char *)value; for (unsigned byte = 0; byte < value->sa_len; byte++) fprintf(output, "%02x", bytes[byte]);
    fputs("\"}", output); comma = 1;
  }
  fputs("}}", output);
}
static void difference(FILE *output, int *comma, const char *field) { fprintf(output, "%s\"%s\"", *comma ? "," : "", field); *comma = 1; }
static void observe(const char *base, const char *operation, Message *baseline, Message *current) {
  char suffix[96], binary[PATH_MAX], json[PATH_MAX], temporary[PATH_MAX];
  snprintf(suffix, sizeof(suffix), ".before-%s-%d.bin", operation, getpid()); owned_path(binary, sizeof(binary), base, suffix);
  FILE *output = pending_receipt(binary, temporary, sizeof(temporary));
  if (current->header.rtm_msglen && fwrite(current->bytes, 1, current->header.rtm_msglen, output) != current->header.rtm_msglen) err(1, "Write complete route observation");
  publish_receipt(output, temporary, binary, 0);
  snprintf(suffix, sizeof(suffix), ".before-%s-%d.json", operation, getpid()); owned_path(json, sizeof(json), base, suffix);
  output = pending_receipt(json, temporary, sizeof(temporary)); fputs("{\"baseline\":", output); describe(output, baseline); fputs(",\"current\":", output); describe(output, current);
  fprintf(output, ",\"sameIdentity\":%s,\"differentPaths\":[", same_identity(baseline, current) ? "true" : "false"); int comma = 0;
  if (exact(baseline) != exact(current)) difference(output, &comma, "exact");
  if (baseline->header.rtm_index != current->header.rtm_index) difference(output, &comma, "interfaceIndex");
  if ((baseline->header.rtm_flags & ~RTF_DONE) != (current->header.rtm_flags & ~RTF_DONE)) difference(output, &comma, "flagsWithoutDone");
  #define METRIC_DIFFERENT(member, field) if (baseline->header.rtm_rmx.member != current->header.rtm_rmx.member) difference(output, &comma, "metrics." field)
  METRIC_DIFFERENT(rmx_locks, "locks"); METRIC_DIFFERENT(rmx_mtu, "mtu"); METRIC_DIFFERENT(rmx_hopcount, "hopcount"); METRIC_DIFFERENT(rmx_expire, "expiryEpochSeconds");
  METRIC_DIFFERENT(rmx_recvpipe, "recvpipe"); METRIC_DIFFERENT(rmx_sendpipe, "sendpipe"); METRIC_DIFFERENT(rmx_ssthresh, "ssthresh"); METRIC_DIFFERENT(rmx_rtt, "rtt"); METRIC_DIFFERENT(rmx_rttvar, "rttvar");
  #undef METRIC_DIFFERENT
  for (unsigned index = 0; index < RTAX_MAX; index++) {
    struct sockaddr *one = address(baseline, 1u << index), *two = address(current, 1u << index);
    if ((!one) != (!two) || (one && (one->sa_len != two->sa_len || memcmp(one, two, one->sa_len)))) {
      char field[64]; snprintf(field, sizeof(field), "addresses.%u", index); difference(output, &comma, field);
    }
  }
  fputs("]}\n", output); publish_receipt(output, temporary, json, 0);
}
static int hex_identity(const char *value, size_t length) {
  if (strlen(value) != length) return 0; for (size_t index = 0; index < length; index++) if (!strchr("0123456789abcdef", value[index])) return 0; return 1;
}
static int owned_interface(const char *value) {
  if (strncmp(value, "feth", 4) || !value[4]) return 0;
  for (const char *digit = value + 4; *digit; digit++) if (*digit < '0' || *digit > '9') return 0;
  return strlen(value) < IFNAMSIZ;
}
static unsigned expected_index(const char *value) {
  char *end = NULL; errno = 0; unsigned long parsed = strtoul(value, &end, 10);
  if (errno || !*value || *end || parsed == 0 || parsed > UINT16_MAX) errx(1, "Invalid bound interface index");
  return (unsigned)parsed;
}
static void mutation_state(char **argv, unsigned owned_index, const char *stage, int started) {
  char filename[PATH_MAX], temporary[PATH_MAX]; owned_path(filename, sizeof(filename), argv[2], ".install-state.json");
  FILE *output = pending_receipt(filename, temporary, sizeof(temporary));
  fprintf(output, "{\"schemaVersion\":1,\"candidateHead\":\"%s\",\"savedRouteSha256\":\"%s\",\"nonce\":\"%s\","
    "\"ownedInterfaceName\":\"%s\",\"ownedInterfaceIndex\":%u,\"mutationMayHaveStarted\":%s,\"stage\":\"%s\"}\n",
    argv[5], argv[6], argv[7], argv[3], owned_index, started ? "true" : "false", stage);
  publish_receipt(output, temporary, filename, 1);
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
  if (geteuid() != 0) errx(1, "Owned route operations require root");
  if (argc == 3 && !strcmp(argv[1], "interface-index")) {
    if (!owned_interface(argv[2])) errx(1, "Only an owned feth interface may be inspected");
    unsigned index = if_nametoindex(argv[2]);
    printf("{\"ownedInterfaceIndex\":%u}\n", index); return 0;
  }
  int snapshot = argc == 5 && !strcmp(argv[1], "snapshot");
  int install = argc == 9 && !strcmp(argv[1], "install"), restore = argc == 9 && !strcmp(argv[1], "restore");
  if (!snapshot && !install && !restore) errx(1, "Invalid owned route operation");
  if (!owned_interface(argv[3])) errx(1, "The route operation must bind an owned feth interface");
  unsigned bound_index = 0;
  if (!snapshot) {
    if ((!hex_identity(argv[5], 40) && !hex_identity(argv[5], 64)) || !hex_identity(argv[6], 64) || !hex_identity(argv[7], 32)) errx(1, "Invalid immutable mutation identity");
    bound_index = expected_index(argv[8]);
  }
  int socket_fd = socket(PF_ROUTE, SOCK_RAW, 0); if (socket_fd < 0) err(1, "PF_ROUTE socket");
  struct timeval timeout = { .tv_sec = 5 }; if (setsockopt(socket_fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout))) err(1, "PF_ROUTE timeout");
  Message current = {0}; int has_current = query(socket_fd, &current);
  if (snapshot) {
    int file = open(argv[2], O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0644); if (file < 0) err(1, "Create original route receipt");
    if (has_current && write(file, current.bytes, current.header.rtm_msglen) != current.header.rtm_msglen) err(1, "Save original route bytes");
    if (fsync(file)) err(1, "Sync original route receipt"); if (close(file)) err(1, "Close original route receipt"); sync_directory(argv[2]);
    printf("{\"exactRouteExisted\":%s,\"interfaceIndex\":%u,\"flags\":%d,\"expiryEpochSeconds\":%lld}\n", has_current ? "true" : "false", current.header.rtm_index, current.header.rtm_flags, (long long)current.header.rtm_rmx.rmx_expire);
    close(socket_fd); return 0;
  }
  Message original = load(argv[2]); int has_original = exact(&original);
  unsigned owned_index = if_nametoindex(argv[3]);
  observe(argv[2], install ? "install" : "restore", &original, &current);
  if (install) {
    if (owned_index != bound_index) errx(1, "The created feth interface identity changed before install");
    mutation_state(argv, bound_index, "preparing", 0);
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
    // This durable marker precedes the first possible route mutation. An
    // interrupted helper must never leave its parent guessing from intent.
    mutation_state(argv, bound_index, "mutation-requested", 1);
    if (has_original) apply(socket_fd, &original, RTM_DELETE);
    apply(socket_fd, &replacement, RTM_ADD);
    if (!query(socket_fd, &current) || current.header.rtm_index != owned_index || !(current.header.rtm_flags & RTF_BROADCAST)) errx(1, "Installed route did not retain the owned broadcast interface");
    if (current.header.rtm_rmx.rmx_mtu != (unsigned)link.ifr_mtu) errx(1, "Installed route changed the owned interface MTU");
    mutation_state(argv, bound_index, "installed", 1);
    printf("{\"installed\":true,\"interfaceIndex\":%u,\"flags\":%d,\"mtu\":%u}\n", current.header.rtm_index, current.header.rtm_flags, current.header.rtm_rmx.rmx_mtu);
  } else {
    if (has_current && has_original && same_identity(&current, &original)) {
      printf("{\"restored\":true,\"alreadyOriginal\":true}\n"); close(socket_fd); return 0;
    }
    if (has_current) {
      if (owned_index != bound_index || current.header.rtm_index != bound_index) errx(1, "Refusing to delete a limited broadcast route owned by another interface");
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
const installationState = savedRoute + '.install-state.json';
let record = { schemaVersion: 3, mode, at: new Date().toISOString(), createdInterfaces: [], interfaceIdentities: {}, operations: [],
  routeRestorationRequired: false, routeRestored: null,
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
function interfaceIndex(name) {
  assert.match(name, /^feth\d+$/u);
  const value = JSON.parse(command('/usr/bin/sudo', ['-n', helper, 'interface-index', name])).ownedInterfaceIndex;
  assert.ok(Number.isInteger(value) && value >= 0 && value <= 65535);
  return value;
}
async function syncDirectory() {
  const owner = await open(directory, 'r'); try { await owner.sync(); } finally { await owner.close(); }
}
async function createInstallationState(identity) {
  const pending = installationState + '.initial-' + process.pid + '-' + identity.nonce;
  const owner = await open(pending, 'wx', 0o600);
  try { await owner.writeFile(JSON.stringify({ ...identity, mutationMayHaveStarted: false, stage: 'not-started' }) + '\n'); await owner.sync(); }
  finally { await owner.close(); }
  // A hard link publishes a complete initial state without replacing any old
  // receipt. Both names are inside this run's owned provisioning directory.
  await link(pending, installationState); await unlink(pending); await syncDirectory();
}
function validateInstallationIdentity(identity) {
  assert.equal(identity.schemaVersion, 1);
  assert.match(identity.candidateHead, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
  assert.equal(identity.candidateHead, record.candidateHead);
  assert.match(identity.savedRouteSha256, /^[0-9a-f]{64}$/u);
  assert.equal(identity.savedRouteSha256, record.originalRouteSha256);
  assert.match(identity.nonce, /^[0-9a-f]{32}$/u);
  assert.equal(identity.ownedInterfaceName, record.interface);
  assert.match(identity.ownedInterfaceName, /^feth\d+$/u);
  assert.ok(Number.isInteger(identity.ownedInterfaceIndex) && identity.ownedInterfaceIndex > 0 && identity.ownedInterfaceIndex <= 65535);
  assert.equal(identity.ownedInterfaceIndex, record.interfaceIdentities[record.interface]);
}
async function readInstallationState() {
  const identity = record.installationIdentity; validateInstallationIdentity(identity);
  const stat = await lstat(installationState); assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'The installation state must be its original regular file.');
  const bytes = await readFile(installationState), state = JSON.parse(bytes);
  for (const [key, value] of Object.entries(identity)) assert.equal(state[key], value, 'The installation state changed immutable field ' + key + '.');
  assert.equal(typeof state.mutationMayHaveStarted, 'boolean');
  assert.ok((state.mutationMayHaveStarted ? ['mutation-requested', 'installed'] : ['not-started', 'preparing']).includes(state.stage));
  record.installationState = { path: installationState, sha256: sha(bytes), observedAt: new Date().toISOString(), value: state };
  return state;
}
function routeArguments(operation) {
  const identity = record.installationIdentity; validateInstallationIdentity(identity);
  return [helper, operation, savedRoute, identity.ownedInterfaceName, record.address, identity.candidateHead,
    identity.savedRouteSha256, identity.nonce, String(identity.ownedInterfaceIndex)];
}
async function captureRouteObservations() {
  const prefix = path.basename(savedRoute) + '.before-';
  const previous = new Map((record.routeObservations ?? []).map(entry => [entry.path, entry.sha256]));
  const observations = record.routeObservations = [], failures = [];
  for (const name of (await readdir(directory)).filter(value => value.startsWith(prefix)).sort()) {
    const match = /^broadcast-route-original\.bin\.before-(install|restore)-(\d+)\.(bin|json)(\.pending-\d+)?$/u.exec(name);
    assert.ok(match, 'Unexpected route observation filename.');
    const absolute = path.join(directory, name), stat = await lstat(absolute);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'A route observation must be an exclusive regular file.');
    const bytes = await readFile(absolute), entry = { path: absolute, size: bytes.length, sha256: sha(bytes),
      operation: match[1], helperPid: Number(match[2]), format: match[3], complete: !match[4],
      candidateHead: record.candidateHead, savedRouteSha256: record.originalRouteSha256 };
    observations.push(entry);
    if (previous.has(absolute) && previous.get(absolute) !== entry.sha256)
      failures.push(new Error('A previously captured route observation changed: ' + absolute));
    if (!entry.complete) { failures.push(new Error('An incomplete route observation remains: ' + absolute)); continue; }
    if (entry.format === 'json') entry.value = JSON.parse(bytes);
  }
  if (failures.length) throw new AggregateError(failures, 'The route observation receipts were not immutable and complete.');
}
const udpLogKeys = ['net.inet.udp.log.enable', 'net.inet.udp.log.remote_port_included'];
function readUdpLog(key) {
  assert.ok(udpLogKeys.includes(key));
  const stdout = command('/usr/sbin/sysctl', ['-n', key]); assert.match(stdout.trim(), /^\d+$/u);
  const value = Number(stdout.trim()); assert.ok(Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff);
  return { key, stdout, value, at: new Date().toISOString() };
}
async function restoreUdpLogging() {
  if (!record.udpLogging?.restoreRequested) return;
  assert.deepEqual(record.udpLogging.original.map(entry => entry.key), udpLogKeys);
  const failures = [];
  for (const key of udpLogKeys) {
    const entry = record.udpLogging.original.find(value => value.key === key);
    try {
      assert.ok(Number.isSafeInteger(entry.value) && entry.value >= 0 && entry.value <= (key.endsWith('.enable') ? 0xffffffff : 65535));
      // Even a partial enable restores BOTH originals. Failure of one key must
      // not prevent attempting the other. No policy/third key is writable.
      if (!record.udpLogging.restored || readUdpLog(key).value !== entry.value)
        await mutate('/usr/bin/sudo', ['-n', '/usr/sbin/sysctl', key + '=' + entry.value], { cleanup: true });
      const observed = readUdpLog(key); (record.udpLogging.restoreReadback ??= []).push(observed);
      assert.equal(observed.value, entry.value, 'The UDP diagnostic logging value was not restored.'); await publish();
    } catch (error) { failures.push(error); (record.udpLogging.restoreErrors ??= []).push({ key, error: errorRecord(error) }); }
  }
  if (failures.length) { record.udpLogging.restored = false; await publish(); throw new AggregateError(failures, 'The original UDP logging values could not both be restored.'); }
  record.udpLogging.restored = true; record.udpLogging.restoredAt = new Date().toISOString(); await publish();
}
async function withUdpLogging() {
  const original = udpLogKeys.map(readUdpLog);
  const usage = command('/usr/sbin/sysctl', ['-n', 'net.inet.udp.log.enable_usage']);
  // Use the actual kernel's declared flag meanings, rather than assuming the
  // fetched XNU revision has the same bits as the running Actions kernel.
  assert.match(usage, /\blog:0x0*8\b/u); assert.match(usage, /\bdropnecp:0x0*1000\b/u);
  record.udpLogging = { original, enableUsage: usage, restoreRequested: true, requestedAt: new Date().toISOString(),
    purpose: 'Temporary UDP_LOG and DROP_NECP diagnostics only; network policy is unchanged.',
    sourceBindings: ['https://github.com/apple-oss-distributions/xnu/blob/main/bsd/netinet/udp_log.h',
      'https://github.com/apple-oss-distributions/xnu/blob/main/bsd/netinet/udp_log.c'] };
  await publish(); // The complete restoration intent precedes either mutation.
  const enabled = Number(BigInt(original[0].value) | 0x1008n);
  await mutate('/usr/bin/sudo', ['-n', '/usr/sbin/sysctl', udpLogKeys[1] + '=65001']);
  await mutate('/usr/bin/sudo', ['-n', '/usr/sbin/sysctl', udpLogKeys[0] + '=' + enabled]);
  record.udpLogging.enabledReadback = udpLogKeys.map(readUdpLog);
  assert.equal(record.udpLogging.enabledReadback[0].value, enabled); assert.equal(record.udpLogging.enabledReadback[1].value, 65001); await publish();
  let primary;
  try { await diagnoseUdp(); } catch (error) { primary = error; }
  try { await restoreUdpLogging(); }
  catch (error) { throw new AggregateError([...(primary ? [primary] : []), error], 'UDP diagnosis and exact logging restoration failed.'); }
  if (primary) throw primary;
}
async function diagnoseUdp() {
  const diagnostic = path.join(path.dirname(fileURLToPath(import.meta.url)), 'macos-udp-diagnostic.js');
  const provisioningDirectory = await realpath(directory), nodeExecutable = await realpath(process.execPath);
  const scopeFile = path.join(provisioningDirectory, 'udp-diagnostic-scope.json');
  const userOutput = path.join(provisioningDirectory, 'udp-diagnostic-user.json'), rootOutput = path.join(provisioningDirectory, 'udp-diagnostic-root.json');
  const scope = { schemaVersion: 1, runId: process.env.GITHUB_RUN_ID, head: command('git', ['rev-parse', 'HEAD']).trim(),
    userId: process.getuid(), nodeExecutable, nodeSha256: sha(await readFile(nodeExecutable)), scriptSha256: sha(await readFile(diagnostic)), provisioningDirectory,
    interface: record.interface, peer: record.peer, address: record.address, peerAddress: record.peerAddress,
    directedBroadcast: record.address.replace(/\.1$/u, '.3'), userOutput, rootOutput };
  assert.ok(scope.userId > 0, 'The official broadcast gate must run as the ordinary runner.');
  await writeFile(scopeFile, JSON.stringify(scope, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  for (const output of [userOutput, rootOutput]) await writeFile(output, '', { flag: 'wx', mode: 0o600 });
  record.udpDiagnostics = { scopeFile, scopeSha256: sha(await readFile(scopeFile)), scriptSha256: scope.scriptSha256,
    diagnosticOnly: true, officialOrdinaryUidGateStillRequired: true, operations: [] }; await publish();
  for (const [role, executable, args, output] of [
    ['ordinary', nodeExecutable, [diagnostic, '--worker', scopeFile, userOutput], userOutput],
    ['root', '/usr/bin/sudo', ['-n', nodeExecutable, diagnostic, '--worker', scopeFile, rootOutput], rootOutput],
  ]) {
    if (interrupted) throw interrupted;
    const operation = { role, executable, args, requestedAt: new Date().toISOString() }; record.udpDiagnostics.operations.push(operation); await publish();
    if (interrupted) throw interrupted;
    // No credential/tool environment is sent to sudo. The worker needs only
    // its fixed, owned topology scope and absolute executable/command paths.
    const child = spawn(executable, args, { env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'pipe'] });
    operation.pid = child.pid; let stdout = '', stderr = '', timedOut = false, forced = false, forceTimer;
    child.stdout.on('data', bytes => { stdout += bytes.toString(); }); child.stderr.on('data', bytes => { stderr += bytes.toString(); });
    const stop = () => { child.kill('SIGTERM'); forceTimer ??= setTimeout(() => { forced = true; child.kill('SIGKILL'); }, 10000); };
    interrupt = stop;
    const timeout = setTimeout(() => { timedOut = true; stop(); }, 45000);
    let result, spawnError;
    try {
      result = await new Promise(resolve => {
        child.once('error', error => { spawnError = errorRecord(error); });
        child.once('close', (code, signal) => resolve({ code, signal, error: spawnError }));
      });
    } finally { clearTimeout(timeout); clearTimeout(forceTimer); interrupt = undefined; }
    operation.result = result; operation.stdout = stdout; operation.stderr = stderr; operation.timedOut = timedOut; operation.forced = forced;
    operation.completedAt = new Date().toISOString(); await publish();
    assert.equal(result.code, 0, 'The ' + role + ' UDP diagnostic failed its infrastructure/cleanup contract.');
    assert.equal(result.signal, null); assert.equal(timedOut, false); assert.equal(forced, false);
    const bytes = await readFile(output), observed = JSON.parse(bytes); operation.outputFile = output; operation.outputSha256 = sha(bytes);
    assert.equal(observed.uid, role === 'root' ? 0 : scope.userId); assert.equal(observed.allSocketsClosed, true);
    assert.equal(observed.phaseAcceptance, false); assert.equal(observed.releaseAcceptance, false);
    await publish(); if (interrupted) throw interrupted;
  }
}
function restore() {
  return restoring ??= (async () => {
    const failures = [];
    try { await restoreUdpLogging(); } catch (error) { failures.push(error); }
    let helperTrusted = false;
    try {
      if (record.createdInterfaces.length || record.installationStateCreated)
        assert.equal(sha(await readFile(helper)), record.helperSha256, 'The owned routing helper changed before cleanup.');
      helperTrusted = true;
    } catch (error) { failures.push(error); }
    let noMutationProved = false;
    if (record.installationStateCreated && !record.routeRestored) {
      record.routeRestorationRequired = null;
      try {
        assert.equal(sha(await readFile(helper)), record.helperSha256, 'The owned routing helper changed before cleanup.');
        assert.equal(sha(await readFile(savedRoute)), record.originalRouteSha256, 'The captured route changed before cleanup.');
        const state = await readInstallationState();
        record.routeRestorationRequired = state.mutationMayHaveStarted;
        if (!state.mutationMayHaveStarted) {
          // Intent is not route ownership. This durable false state proves the
          // helper never reached RTM_DELETE/ADD, so leave the current route alone.
          record.restoration = { notInstalled: true, notOwned: true, mutationMayHaveStarted: false,
            reason: 'The owned helper did not reach any route mutation.' };
          noMutationProved = true;
          record.routeRestored = null; record.routeAfterNoMutation = route();
        } else {
          record.restoration = JSON.parse(await mutate('/usr/bin/sudo', routeArguments('restore'), { cleanup: true }));
          assert.equal(record.restoration.restored, true);
          record.routeRestored = true; record.routeAfterRestore = route();
        }
        await publish();
      } catch (error) { failures.push(error); }
    }
    try { await captureRouteObservations(); } catch (error) { failures.push(error); }
    // Preserve interfaces if restoring the old route failed: a still-live owned
    // route must not lose the interface needed for an explicit cleanup retry.
    const routeSafelyReleased = record.routeRestored === true || !record.installationStateCreated || noMutationProved;
    if (routeSafelyReleased && helperTrusted) for (const name of [...record.createdInterfaces].reverse()) {
      if ((record.destroyedInterfaces ?? []).includes(name)) continue;
      try {
        assert.ok(Number.isInteger(record.interfaceIdentities[name]) && record.interfaceIdentities[name] > 0,
          'An interface cannot be destroyed without its captured kernel index.');
        const currentIndex = interfaceIndex(name);
        if (!currentIndex) {
          (record.alreadyAbsentInterfaces ??= []).push(name); continue;
        }
        assert.equal(currentIndex, record.interfaceIdentities[name], 'The feth name no longer identifies the interface created by this run.');
        await mutate('/usr/bin/sudo', ['/sbin/ifconfig', name, 'destroy'], { cleanup: true, onSuccess: () => (record.destroyedInterfaces ??= []).push(name) });
      } catch (error) { failures.push(error); }
    }
    record.cleanupInterfaces = interfaces(); record.cleanupRoutes = routes(); record.defaultRouteAfter = defaultRoute();
    if (record.defaultRoute) {
      assert.deepEqual(defaultIdentity(record.defaultRouteAfter), defaultIdentity(record.defaultRoute), 'The IPv4 default route changed.');
    }
    for (const name of [...(record.destroyedInterfaces ?? []), ...(record.alreadyAbsentInterfaces ?? [])])
      assert.ok(!record.cleanupInterfaces.split('\n').some(line => line.startsWith(name + ':')), 'An owned feth interface remained after cleanup.');
    record.cleanupCompleted = !failures.length; record.cleanedAt = new Date().toISOString(); await publish();
    if (failures.length) throw new AggregateError(failures, 'The owned broadcast topology could not be fully restored.');
  })();
}
if (mode === 'cleanup') {
  try { record = JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') process.exit(0); throw error; }
  assert.equal(record.schemaVersion, 3, 'Cleanup requires the corresponding owned-topology receipt.');
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
  record.candidateHead = command('git', ['rev-parse', 'HEAD']).trim();
  assert.match(record.candidateHead, /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
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
    await mutate('/usr/bin/sudo', ['/sbin/ifconfig', name, 'create'], { onSuccess: () => {
      record.createdInterfaces.push(name);
      record.interfaceIdentities[name] = interfaceIndex(name);
      assert.ok(record.interfaceIdentities[name] > 0, 'The created interface must have a real kernel index.');
    } });
  }
  await mutate('/usr/bin/sudo', ['/sbin/ifconfig', pair[0], 'peer', pair[1]]);
  await mutate('/usr/bin/sudo', ['/sbin/ifconfig', pair[0], 'inet', record.address, 'netmask', '255.255.255.252', 'up']);
  await mutate('/usr/bin/sudo', ['/sbin/ifconfig', pair[1], 'inet', record.peerAddress, 'netmask', '255.255.255.252', 'up']);
  record.topology = pair.map(name => command('/sbin/ifconfig', [name]));
  for (const description of record.topology) {
    assert.match(description, /<[^>]*\bBROADCAST\b[^>]*>/u); assert.match(description, /\bstatus: active\b/u);
  }
  record.installationIdentity = { schemaVersion: 1, candidateHead: record.candidateHead, savedRouteSha256: record.originalRouteSha256,
    nonce: randomBytes(16).toString('hex'), ownedInterfaceName: record.interface, ownedInterfaceIndex: record.interfaceIdentities[record.interface] };
  validateInstallationIdentity(record.installationIdentity);
  await createInstallationState(record.installationIdentity); record.installationStateCreated = true;
  await readInstallationState(); await publish();
  record.replacementRequested = true; record.routeRestorationRequired = null; await publish();
  assert.equal(sha(await readFile(helper)), record.helperSha256, 'The owned routing helper changed before install.');
  assert.equal(sha(await readFile(savedRoute)), record.originalRouteSha256, 'The captured route changed before install.');
  record.installation = JSON.parse(await mutate('/usr/bin/sudo', routeArguments('install')));
  const installedState = await readInstallationState();
  assert.equal(installedState.mutationMayHaveStarted, true); assert.equal(installedState.stage, 'installed');
  record.routeRestorationRequired = true;
  await captureRouteObservations(); await publish();
  record.routeAfter = route(); record.routesAfter = routes();
  record.defaultRouteAfterSetup = defaultRoute();
  assert.deepEqual(defaultIdentity(record.defaultRouteAfterSetup), defaultIdentity(record.defaultRoute), 'Broadcast setup changed the default route.');
  assert.match(record.routeAfter, /^\s*destination: 255\.255\.255\.255\s*$/mu);
  assert.equal(/^\s*interface: (\S+)\s*$/mu.exec(record.routeAfter)?.[1], record.interface);
  assert.match(record.routeAfter, /flags: <[^>]*\bBROADCAST\b[^>]*>/u);
  await withUdpLogging();
  await verifyPackets(); if (interrupted) throw interrupted; record.verified = true;
} catch (error) { failure = error; record.error = errorRecord(error); }
finally {
  if (failure || interrupted) {
    try { await restore(); } catch (cleanupError) { record.cleanupError = errorRecord(cleanupError); failure = new AggregateError([failure ?? interrupted, cleanupError], 'Broadcast setup and restoration failed.'); }
  }
  try { await captureRouteObservations(); }
  catch (error) {
    record.routeObservationError = errorRecord(error);
    failure = failure ? new AggregateError([failure, error], 'Broadcast setup and route observation failed.') : error;
    try { await restore(); } catch (cleanupError) { record.cleanupError = errorRecord(cleanupError); failure = new AggregateError([failure, cleanupError], 'Route observation and restoration failed.'); }
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
