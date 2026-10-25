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
const errorRecord = error => {
  if (error === null || typeof error !== 'object') return error;
  return { name: error.name, message: error.message, stack: error.stack, status: error.status, statusCode: error.statusCode,
    code: error.code, errno: error.errno, syscall: error.syscall, path: error.path, signal: error.signal,
    stdout: error.stdout?.toString(), stderr: error.stderr?.toString(),
    cause: error.cause === undefined ? undefined : errorRecord(error.cause), errors: error.errors?.map(errorRecord) };
};
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
// XNU rt_getmetrics projects expiry from uptime to wall-clock seconds through
// NET_CALCULATE_CLOCKSKEW. Re-observe the SAME saved identity with RTM_GET only;
// every field must still match exactly. This never rebases or retries mutation.
// https://github.com/apple-oss-distributions/xnu/blob/main/bsd/net/rtsock.c
// https://github.com/apple-oss-distributions/xnu/blob/main/bsd/net/route_private.h
// Before the first seal, inspect the original owner before creating the feth
// pair, then acquire a stable full identity after its real network setup. XNU's
// net_uptime is a cached coarse clock; two early reads alone cannot establish
// stability across the subsequent interface activity. Preflight is not a seal.
// https://github.com/apple-oss-distributions/xnu/blob/xnu-11215.81.4/bsd/kern/uipc_domain.c
// PF_ROUTE also publishes interface/address notifications with a shorter header.
// Inspect their common length/version/type prefix before expecting rt_msghdr.
// https://github.com/apple-oss-distributions/xnu/blob/xnu-11215.81.4/bsd/net/if.h
const routeSource = String.raw`
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <sys/ioctl.h>
#include <sys/sysctl.h>
#include <sys/proc_info.h>
#include <net/if.h>
#include <net/if_dl.h>
#include <net/if_types.h>
#include <net/route.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <err.h>
#include <errno.h>
#include <fcntl.h>
#include <libproc.h>
#include <stdarg.h>
#include <limits.h>
#include <stdint.h>
#include <stddef.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

typedef union { struct rt_msghdr header; unsigned char bytes[8192]; } Message;
static int sequence;
static uint64_t observation_deadline;
static uint64_t monotonic_milliseconds(void);
static const char *notification_base;
static unsigned notification_sequence;
static void record_notification(Message *message, size_t length);
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
  const uint64_t deadline = observation_deadline ? observation_deadline : monotonic_milliseconds() + 5000u;
  for (;;) {
    // Unrelated PF_ROUTE notifications cannot restart the observation budget.
    {
      uint64_t now = monotonic_milliseconds();
      if (now >= deadline) return ETIMEDOUT;
      uint64_t remaining = deadline - now;
      struct timeval timeout = { .tv_sec = (time_t)(remaining / 1000u), .tv_usec = (suseconds_t)((remaining % 1000u) * 1000u) };
      if (setsockopt(socket_fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout))) return errno;
    }
    ssize_t length = read(socket_fd, reply->bytes, sizeof(*reply));
    if (length < 0) return errno;
    if ((size_t)length < offsetof(struct rt_msghdr, rtm_type) + sizeof(reply->header.rtm_type)) {
      fprintf(stderr, "PF_ROUTE truncated message prefix: received=%zd\n", length); return EIO;
    }
    if (reply->header.rtm_version != RTM_VERSION || reply->header.rtm_type != type) {
      record_notification(reply, (size_t)length); continue;
    }
    if ((size_t)length < sizeof(struct rt_msghdr) || reply->header.rtm_msglen < sizeof(struct rt_msghdr)) {
      fprintf(stderr, "PF_ROUTE truncated route reply: received=%zd declared=%u\n", length, reply->header.rtm_msglen); return EIO;
    }
    if (reply->header.rtm_pid != getpid() || reply->header.rtm_seq != sequence) continue;
    if (reply->header.rtm_msglen > length) {
      fprintf(stderr, "PF_ROUTE incomplete matching reply: received=%zd declared=%u\n", length, reply->header.rtm_msglen); return EIO;
    }
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
// Only the unsealed precapture phase uses this narrower admission predicate.
// It preserves presence, owner, all addresses/flags, every non-expiry metric,
// and the zero/nonzero expiry class. The final stable pair, install and restore
// all continue to use the complete same_identity above, including expiry.
static int precapture_identity(Message *left, Message *right) {
  const int has_left = exact(left), has_right = exact(right);
  if (has_left != has_right) return 0;
  if (!has_left) return !left->header.rtm_msglen && !right->header.rtm_msglen;
  if (left->header.rtm_index != right->header.rtm_index
    || (left->header.rtm_flags & ~RTF_DONE) != (right->header.rtm_flags & ~RTF_DONE)) return 0;
  struct rt_metrics one_metric = left->header.rtm_rmx, two_metric = right->header.rtm_rmx;
  if ((one_metric.rmx_expire == 0) != (two_metric.rmx_expire == 0)
    || one_metric.rmx_locks != two_metric.rmx_locks || one_metric.rmx_mtu != two_metric.rmx_mtu
    || one_metric.rmx_hopcount != two_metric.rmx_hopcount
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
static void record_notification(Message *message, size_t length) {
  char suffix[96], binary[PATH_MAX], json[PATH_MAX], temporary[PATH_MAX];
  unsigned ordinal = ++notification_sequence;
  snprintf(suffix, sizeof(suffix), ".notification-%d-%u.bin", getpid(), ordinal);
  owned_path(binary, sizeof(binary), notification_base, suffix);
  FILE *output = pending_receipt(binary, temporary, sizeof(temporary));
  if (fwrite(message->bytes, 1, length, output) != length) err(1, "Write unrelated route notification");
  publish_receipt(output, temporary, binary, 0);
  snprintf(suffix, sizeof(suffix), ".notification-%d-%u.json", getpid(), ordinal);
  owned_path(json, sizeof(json), notification_base, suffix);
  output = pending_receipt(json, temporary, sizeof(temporary));
  fprintf(output, "{\"helperPid\":%d,\"ordinal\":%u,\"receivedBytes\":%zu,\"declaredBytes\":%u,\"version\":%u,\"type\":%u,"
    "\"routeHeaderBytes\":%zu,\"monotonicMilliseconds\":%llu,\"observationDeadlineMonotonicMilliseconds\":%llu,\"usedAsRouteObservation\":false}\n",
    getpid(), ordinal, length, message->header.rtm_msglen, message->header.rtm_version, message->header.rtm_type,
    sizeof(struct rt_msghdr), (unsigned long long)monotonic_milliseconds(), (unsigned long long)observation_deadline);
  publish_receipt(output, temporary, json, 0);
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
static uint64_t observe(const char *base, const char *operation, unsigned attempt, Message *baseline, Message *current) {
  char suffix[96], binary[PATH_MAX], json[PATH_MAX], temporary[PATH_MAX];
  snprintf(suffix, sizeof(suffix), ".before-%s-%d-attempt-%u.bin", operation, getpid(), attempt); owned_path(binary, sizeof(binary), base, suffix);
  FILE *output = pending_receipt(binary, temporary, sizeof(temporary));
  if (current->header.rtm_msglen && fwrite(current->bytes, 1, current->header.rtm_msglen, output) != current->header.rtm_msglen) err(1, "Write complete route observation");
  publish_receipt(output, temporary, binary, 0);
  snprintf(suffix, sizeof(suffix), ".before-%s-%d-attempt-%u.json", operation, getpid(), attempt); owned_path(json, sizeof(json), base, suffix);
  output = pending_receipt(json, temporary, sizeof(temporary));
  uint64_t observed_at = monotonic_milliseconds();
  const int unsealed = !strcmp(operation, "preflight") || !strcmp(operation, "precapture");
  fprintf(output, "{\"operation\":\"%s\",\"attempt\":%u,\"readOnlyObservation\":true,"
    "\"baselineSealed\":%s,\"comparisonReference\":\"%s\","
    "\"monotonicMilliseconds\":%llu,\"deadlineMonotonicMilliseconds\":%llu,\"baseline\":", operation, attempt,
    unsealed ? "false" : "true", unsealed ? "unsealed-preflight" : "sealed-original",
    (unsigned long long)observed_at, (unsigned long long)observation_deadline);
  describe(output, baseline); fputs(",\"current\":", output); describe(output, current);
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
  return observed_at;
}
static uint64_t monotonic_milliseconds(void) {
  struct timespec current;
  if (clock_gettime(CLOCK_MONOTONIC, &current)) err(1, "Read monotonic observation clock");
  return (uint64_t)current.tv_sec * 1000u + (uint64_t)current.tv_nsec / 1000000u;
}
static int observe_original(int socket_fd, const char *base, const char *operation, Message *original, Message *current, int *has_current) {
  const uint64_t deadline = monotonic_milliseconds() + 2000u;
  const int has_original = exact(original);
  int matched = 0;
  observation_deadline = deadline;
  for (unsigned attempt = 1; attempt <= 16; attempt++) {
    uint64_t now = monotonic_milliseconds();
    if (now >= deadline) break;
    memset(current, 0, sizeof(*current)); *has_current = query(socket_fd, current);
    observe(base, operation, attempt, original, current);
    now = monotonic_milliseconds();
    if (now <= deadline && *has_current == has_original && (!has_original || same_identity(current, original))) { matched = 1; break; }
    if (attempt == 16 || now >= deadline || deadline - now <= 100u) break;
    if (usleep(100000)) err(1, "Wait for exact route re-observation");
  }
  observation_deadline = 0;
  struct timeval timeout = { .tv_sec = 5 };
  if (setsockopt(socket_fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout))) err(1, "Restore route socket timeout");
  return matched;
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
static void save_route(const char *filename, Message *value) {
  char temporary[PATH_MAX]; FILE *output = pending_receipt(filename, temporary, sizeof(temporary));
  if (value->header.rtm_msglen && fwrite(value->bytes, 1, value->header.rtm_msglen, output) != value->header.rtm_msglen) err(1, "Save complete route bytes");
  // A complete/fsynced message is published once through an exclusive link.
  // Existing original or preflight names are never replaced.
  publish_receipt(output, temporary, filename, 0);
}
static void apply(int socket_fd, Message *value, int type) {
  Message request = *value, reply = {0}; require_exact(&request); request.header.rtm_flags &= ~RTF_DONE;
  if (type != RTM_ADD) request.header.rtm_inits = 0;
  int error = exchange(socket_fd, &request, &reply, type);
  if (error) { errno = error; err(1, type == RTM_ADD ? "RTM_ADD limited broadcast" : "RTM_DELETE limited broadcast"); }
}
static uint64_t realtime_milliseconds(void) {
  struct timespec current;
  if (clock_gettime(CLOCK_REALTIME, &current)) err(1, "Read route observation realtime");
  return (uint64_t)current.tv_sec * 1000u + (uint64_t)current.tv_nsec / 1000000u;
}
// Ordinary-user, read-only diagnostics. A routing PID and a process observed
// after its frame are separate evidence: an executable can change on exec.
// https://github.com/apple-oss-distributions/xnu/blob/xnu-11417.140.69/bsd/sys/sysctl.h
// https://github.com/apple-oss-distributions/xnu/blob/xnu-11417.140.69/libsyscall/wrappers/libproc/libproc.h
typedef struct {
  int file, incomplete, initial_complete, byte_limited;
  size_t bytes, records, omitted, errors, lookup_failures, initial_count;
  struct kinfo_proc *initial;
  uint64_t initial_epoch, initial_monotonic;
  char path[PATH_MAX], quoted_path[PATH_MAX * 6 + 3];
} ActorDiagnostic;
static const size_t actor_byte_limit = 2u * 1024u * 1024u;
static const size_t actor_initial_byte_limit = 1024u * 1024u;
static void actor_quote(char *output, const char *value, size_t length) {
  static const char digits[] = "0123456789abcdef";
  char *cursor = output; *cursor++ = '"';
  for (size_t index = 0; index < length; index++) {
    const unsigned char byte = (unsigned char)value[index];
    if (byte == '"' || byte == '\\') { *cursor++ = '\\'; *cursor++ = (char)byte; }
    else if (byte < 32u) { *cursor++ = '\\'; *cursor++ = 'u'; *cursor++ = '0'; *cursor++ = '0'; *cursor++ = digits[byte >> 4u]; *cursor++ = digits[byte & 15u]; }
    else *cursor++ = (char)byte;
  }
  *cursor++ = '"'; *cursor = 0;
}
static void actor_error(ActorDiagnostic *diagnostic, const char *stage, int error) {
  char quoted[1539]; const char *message = strerror(error);
  actor_quote(quoted, message, strnlen(message, 256));
  diagnostic->incomplete = 1; diagnostic->errors++;
  fprintf(stderr, "{\"diagnosticOnly\":true,\"kind\":\"route-actor-error\",\"stage\":\"%s\",\"errno\":%d,\"message\":%s}\n", stage, error, quoted); fflush(stderr);
}
static void actor_clocks(ActorDiagnostic *diagnostic, uint64_t *epoch, uint64_t *monotonic) {
  struct timespec value; *epoch = 0; *monotonic = 0;
  if (clock_gettime(CLOCK_REALTIME, &value)) actor_error(diagnostic, "read-diagnostic-realtime", errno);
  else *epoch = (uint64_t)value.tv_sec * 1000u + (uint64_t)value.tv_nsec / 1000000u;
  if (clock_gettime(CLOCK_MONOTONIC, &value)) actor_error(diagnostic, "read-diagnostic-monotonic", errno);
  else *monotonic = (uint64_t)value.tv_sec * 1000u + (uint64_t)value.tv_nsec / 1000000u;
}
static void actor_line(ActorDiagnostic *diagnostic, const char *format, ...) {
  if (diagnostic->file < 0) { diagnostic->omitted++; return; }
  char line[32768]; va_list arguments; va_start(arguments, format);
  const int length = vsnprintf(line, sizeof(line), format, arguments); va_end(arguments);
  if (length < 0 || (size_t)length >= sizeof(line) || (size_t)length > actor_byte_limit - diagnostic->bytes) {
    diagnostic->omitted++;
    if (!diagnostic->byte_limited) actor_error(diagnostic, "sidecar-byte-limit-or-record-size", EOVERFLOW);
    diagnostic->byte_limited = 1;
    diagnostic->incomplete = 1; return;
  }
  size_t written = 0;
  while (written < (size_t)length) {
    const ssize_t count = write(diagnostic->file, line + written, (size_t)length - written);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) {
      actor_error(diagnostic, "write-sidecar", count < 0 ? errno : EIO);
      if (close(diagnostic->file)) actor_error(diagnostic, "close-failed-sidecar", errno);
      diagnostic->file = -1; diagnostic->omitted++; return;
    }
    written += (size_t)count; diagnostic->bytes += (size_t)count;
  }
  diagnostic->records++;
}
static int actor_same_birth(const struct kinfo_proc *left, const struct kinfo_proc *right) {
  return left->kp_proc.p_pid == right->kp_proc.p_pid
    && left->kp_proc.p_starttime.tv_sec == right->kp_proc.p_starttime.tv_sec
    && left->kp_proc.p_starttime.tv_usec == right->kp_proc.p_starttime.tv_usec;
}
static int actor_process(pid_t pid, struct kinfo_proc *value, size_t *returned) {
  int names[] = {CTL_KERN, KERN_PROC, KERN_PROC_PID, pid};
  memset(value, 0, sizeof(*value)); *returned = sizeof(*value);
  if (sysctl(names, 4, value, returned, NULL, 0)) return errno;
  if (*returned != sizeof(*value) || value->kp_proc.p_pid != pid || value->kp_proc.p_starttime.tv_sec <= 0
    || value->kp_proc.p_starttime.tv_usec < 0 || value->kp_proc.p_starttime.tv_usec >= 1000000) return ESRCH;
  return 0;
}
static void actor_begin(ActorDiagnostic *diagnostic, const char *filename) {
  memset(diagnostic, 0, sizeof(*diagnostic)); diagnostic->file = -1;
  const int length = snprintf(diagnostic->path, sizeof(diagnostic->path), "%s.actors.jsonl", filename);
  if (length < 0 || (size_t)length >= sizeof(diagnostic->path)) { actor_error(diagnostic, "sidecar-path", ENAMETOOLONG); strcpy(diagnostic->quoted_path, "null"); return; }
  actor_quote(diagnostic->quoted_path, diagnostic->path, (size_t)length);
  diagnostic->file = open(diagnostic->path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (diagnostic->file < 0) { actor_error(diagnostic, "open-sidecar", errno); return; }
  // Capture births before opening PF_ROUTE. A later lookup alone cannot rule
  // out a PID being reused while a route message was waiting in its queue.
  diagnostic->initial = malloc(actor_initial_byte_limit);
  if (!diagnostic->initial) actor_error(diagnostic, "allocate-initial-process-snapshot", ENOMEM);
  else {
    int names[] = {CTL_KERN, KERN_PROC, KERN_PROC_ALL}; size_t bytes = actor_initial_byte_limit;
    if (sysctl(names, 3, diagnostic->initial, &bytes, NULL, 0)) actor_error(diagnostic, "read-initial-process-snapshot", errno);
    else if (bytes > actor_initial_byte_limit || bytes % sizeof(*diagnostic->initial)) actor_error(diagnostic, "initial-process-snapshot-size", EOVERFLOW);
    else { diagnostic->initial_count = bytes / sizeof(*diagnostic->initial); diagnostic->initial_complete = 1; }
  }
  actor_clocks(diagnostic, &diagnostic->initial_epoch, &diagnostic->initial_monotonic);
  actor_line(diagnostic, "{\"kind\":\"initial-process-snapshot\",\"schemaVersion\":1,\"diagnosticOnly\":true,\"observerPid\":%d,\"uid\":%u,\"byteLimit\":%zu,\"initialSnapshotByteLimit\":%zu,\"initialSnapshotComplete\":%s,\"count\":%zu,\"epochMilliseconds\":%llu,\"monotonicMilliseconds\":%llu}\n",
    getpid(), (unsigned)getuid(), actor_byte_limit, actor_initial_byte_limit, diagnostic->initial_complete ? "true" : "false", diagnostic->initial_count,
    (unsigned long long)diagnostic->initial_epoch, (unsigned long long)diagnostic->initial_monotonic);
  for (size_t index = 0; index < diagnostic->initial_count; index++) {
    const struct kinfo_proc *value = diagnostic->initial + index;
    actor_line(diagnostic, "{\"kind\":\"birth-before-route-socket\",\"pid\":%d,\"parentPid\":%d,\"uid\":%u,\"startedSeconds\":%lld,\"startedMicroseconds\":%ld}\n",
      value->kp_proc.p_pid, value->kp_eproc.e_ppid, (unsigned)value->kp_eproc.e_ucred.cr_uid,
      (long long)value->kp_proc.p_starttime.tv_sec, (long)value->kp_proc.p_starttime.tv_usec);
  }
}
static void actor_observe(ActorDiagnostic *diagnostic, const unsigned char *message, size_t length,
  size_t ordinal, size_t offset, uint64_t epoch, uint64_t monotonic) {
  if (length < sizeof(struct rt_msghdr)) return;
  struct rt_msghdr header; memcpy(&header, message, sizeof(header));
  if (header.rtm_version != RTM_VERSION || header.rtm_type < RTM_ADD || header.rtm_type > RTM_GET || header.rtm_pid <= 0) return;
  struct kinfo_proc before, after; size_t before_bytes, after_bytes;
  uint64_t read_epoch, read_monotonic; actor_clocks(diagnostic, &read_epoch, &read_monotonic);
  const int before_error = actor_process(header.rtm_pid, &before, &before_bytes);
  char executable[PROC_PIDPATHINFO_MAXSIZE] = {0}, quoted_executable[PROC_PIDPATHINFO_MAXSIZE * 6 + 3];
  errno = 0; const int path_bytes = proc_pidpath(header.rtm_pid, executable, sizeof(executable)), path_error = path_bytes > 0 ? 0 : errno;
  actor_quote(quoted_executable, executable, strnlen(executable, sizeof(executable)));
  const int after_error = actor_process(header.rtm_pid, &after, &after_bytes);
  uint64_t finished_epoch, finished_monotonic; actor_clocks(diagnostic, &finished_epoch, &finished_monotonic);
  if (before_error || after_error || path_bytes <= 0) { diagnostic->incomplete = 1; diagnostic->lookup_failures++; }
  const int same_birth = !before_error && !after_error && actor_same_birth(&before, &after);
  const struct kinfo_proc *initial = NULL;
  for (size_t index = 0; index < diagnostic->initial_count; index++) if (diagnostic->initial[index].kp_proc.p_pid == header.rtm_pid) { initial = diagnostic->initial + index; break; }
  const int same_initial = same_birth && initial && actor_same_birth(initial, &after);
  actor_line(diagnostic, "{\"kind\":\"post-frame-process-observation\",\"diagnosticOnly\":true,\"frameOrdinal\":%zu,\"frameOffset\":%zu,\"frameBytes\":%zu,\"type\":%u,\"pid\":%d,\"sequence\":%d,\"routeErrno\":%d,\"frameEpochMilliseconds\":%llu,\"frameMonotonicMilliseconds\":%llu,\"readStartedEpochMilliseconds\":%llu,\"readStartedMonotonicMilliseconds\":%llu,\"readFinishedEpochMilliseconds\":%llu,\"readFinishedMonotonicMilliseconds\":%llu,\"before\":{\"errno\":%d,\"bytes\":%zu,\"pid\":%d,\"parentPid\":%d,\"uid\":%u,\"startedSeconds\":%lld,\"startedMicroseconds\":%ld},\"executableObservedAfterFrame\":%s,\"pathReturned\":%d,\"pathErrno\":%d,\"after\":{\"errno\":%d,\"bytes\":%zu,\"pid\":%d,\"parentPid\":%d,\"uid\":%u,\"startedSeconds\":%lld,\"startedMicroseconds\":%ld},\"sameBirthAcrossRead\":%s,\"sameBirthAsPreSocketSnapshot\":%s,\"eventIssuerExecutableCertified\":false}\n",
    ordinal, offset, length, (unsigned)header.rtm_type, header.rtm_pid, header.rtm_seq, header.rtm_errno,
    (unsigned long long)epoch, (unsigned long long)monotonic, (unsigned long long)read_epoch, (unsigned long long)read_monotonic,
    (unsigned long long)finished_epoch, (unsigned long long)finished_monotonic,
    before_error, before_bytes, before.kp_proc.p_pid, before.kp_eproc.e_ppid, (unsigned)before.kp_eproc.e_ucred.cr_uid,
    (long long)before.kp_proc.p_starttime.tv_sec, (long)before.kp_proc.p_starttime.tv_usec,
    path_bytes > 0 ? quoted_executable : "null", path_bytes, path_error,
    after_error, after_bytes, after.kp_proc.p_pid, after.kp_eproc.e_ppid, (unsigned)after.kp_eproc.e_ucred.cr_uid,
    (long long)after.kp_proc.p_starttime.tv_sec, (long)after.kp_proc.p_starttime.tv_usec,
    same_birth ? "true" : "false", same_initial ? "true" : "false");
}
static void actor_end(ActorDiagnostic *diagnostic) {
  if (diagnostic->file >= 0) {
    if (fsync(diagnostic->file)) actor_error(diagnostic, "sync-sidecar", errno);
    if (close(diagnostic->file)) actor_error(diagnostic, "close-sidecar", errno);
    diagnostic->file = -1;
  }
  free(diagnostic->initial); diagnostic->initial = NULL;
}
static int observe_notifications(const char *filename) {
  // This separate operation never sends a routing message or loads a baseline.
  // Each frame has little-endian length (u32), realtime/monotonic milliseconds
  // (u64 each), then the unmodified bytes returned by the routing socket.
  int output = open(filename, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (output < 0) err(1, "Create read-only route observation");
  ActorDiagnostic actors; actor_begin(&actors, filename);
  int source = socket(PF_ROUTE, SOCK_RAW, 0); if (source < 0) err(1, "Observe PF_ROUTE notifications");
  const size_t limit = 8u * 1024u * 1024u;
  const uint64_t started = monotonic_milliseconds(), duration = 2u * 60u * 60u * 1000u, deadline = started + duration;
  size_t bytes = 0, messages = 0; int limited = 0, time_limited = 0, stopping = 0;
  printf("{\"observing\":true,\"schemaVersion\":1,\"pid\":%d,\"uid\":%u,\"byteLimit\":%zu,\"durationLimitMilliseconds\":%llu,\"framePrefixBytes\":20,\"epochMilliseconds\":%llu,\"monotonicMilliseconds\":%llu,\"actorDiagnostic\":{\"path\":%s,\"byteLimit\":%zu,\"initialSnapshotByteLimit\":%zu}}\n",
    getpid(), (unsigned)getuid(), limit, (unsigned long long)duration, (unsigned long long)realtime_milliseconds(), (unsigned long long)started,
    actors.quoted_path, actor_byte_limit, actor_initial_byte_limit); fflush(stdout);
  for (;;) {
    uint64_t now = monotonic_milliseconds(); if (now >= deadline) { time_limited = 1; break; }
    struct pollfd descriptors[2] = {{.fd = STDIN_FILENO, .events = POLLIN}, {.fd = source, .events = POLLIN}};
    int result = poll(descriptors, 2, stopping ? 0 : (int)(deadline - now));
    if (result < 0) { if (errno == EINTR) continue; err(1, "Wait for route observation"); }
    if (descriptors[0].revents & (POLLIN | POLLHUP | POLLERR | POLLNVAL)) stopping = 1;
    if (descriptors[1].revents & (POLLERR | POLLHUP | POLLNVAL)) errx(1, "The observed routing socket closed");
    if (!(descriptors[1].revents & POLLIN)) { if (stopping) break; continue; }
    unsigned char message[65536]; ssize_t length = read(source, message, sizeof(message));
    if (length < 0) { if (errno == EINTR) continue; err(1, "Read route observation"); }
    if (!length) errx(1, "The observed routing socket returned EOF");
    if ((size_t)length + 20u > limit - bytes) { limited = 1; break; }
    const uint64_t epoch = realtime_milliseconds();
    const uint64_t monotonic = monotonic_milliseconds();
    const uint32_t count = (uint32_t)length;
    unsigned char prefix[20] = {count & 255u, (count >> 8u) & 255u, (count >> 16u) & 255u, (count >> 24u) & 255u};
    for (unsigned index = 0; index < 8; index++) { prefix[4 + index] = (epoch >> (index * 8u)) & 255u; prefix[12 + index] = (monotonic >> (index * 8u)) & 255u; }
    for (unsigned part = 0; part < 2; part++) {
      const unsigned char *data = part ? message : prefix; size_t remaining = part ? (size_t)length : sizeof(prefix);
      while (remaining) {
        ssize_t written = write(output, data, remaining);
        if (written < 0) { if (errno == EINTR) continue; err(1, "Write raw route observation"); }
        if (!written) errx(1, "The route observation write made no progress");
        data += written; remaining -= (size_t)written; bytes += (size_t)written;
      }
    }
    messages++;
    actor_observe(&actors, message, (size_t)length, messages, bytes - (size_t)length - 20u, epoch, monotonic);
  }
  if (close(source)) err(1, "Close observed routing socket");
  if (fsync(output)) err(1, "Sync raw route observation");
  if (close(output)) err(1, "Close raw route observation");
  actor_end(&actors);
  printf("{\"observing\":false,\"bytes\":%zu,\"messages\":%zu,\"byteLimitReached\":%s,\"durationLimitReached\":%s,\"epochMilliseconds\":%llu,\"monotonicMilliseconds\":%llu,\"actorDiagnostic\":{\"path\":%s,\"bytes\":%zu,\"records\":%zu,\"omittedRecords\":%zu,\"errors\":%zu,\"lookupFailures\":%zu,\"byteLimitReached\":%s,\"incomplete\":%s,\"initialSnapshotComplete\":%s}}\n",
    bytes, messages, limited ? "true" : "false", time_limited ? "true" : "false", (unsigned long long)realtime_milliseconds(), (unsigned long long)monotonic_milliseconds(),
    actors.quoted_path, actors.bytes, actors.records, actors.omitted, actors.errors, actors.lookup_failures, actors.byte_limited ? "true" : "false", actors.incomplete ? "true" : "false", actors.initial_complete ? "true" : "false"); fflush(stdout);
  return 0;
}
int main(int argc, char **argv) {
  if (argc == 3 && !strcmp(argv[1], "observe")) return observe_notifications(argv[2]);
  if (geteuid() != 0) errx(1, "Owned route operations require root");
  if (argc == 3 && !strcmp(argv[1], "interface-index")) {
    if (!owned_interface(argv[2])) errx(1, "Only an owned feth interface may be inspected");
    unsigned index = if_nametoindex(argv[2]);
    printf("{\"ownedInterfaceIndex\":%u}\n", index); return 0;
  }
  int preflight = argc == 5 && !strcmp(argv[1], "preflight");
  int snapshot = argc == 5 && !strcmp(argv[1], "snapshot");
  int install = argc == 9 && !strcmp(argv[1], "install"), restore = argc == 9 && !strcmp(argv[1], "restore");
  if (!preflight && !snapshot && !install && !restore) errx(1, "Invalid owned route operation");
  if (!owned_interface(argv[3])) errx(1, "The route operation must bind an owned feth interface");
  notification_base = argv[2];
  unsigned bound_index = 0;
  if (!preflight && !snapshot) {
    if ((!hex_identity(argv[5], 40) && !hex_identity(argv[5], 64)) || !hex_identity(argv[6], 64) || !hex_identity(argv[7], 32)) errx(1, "Invalid immutable mutation identity");
    bound_index = expected_index(argv[8]);
  }
  int socket_fd = socket(PF_ROUTE, SOCK_RAW, 0); if (socket_fd < 0) err(1, "PF_ROUTE socket");
  struct timeval timeout = { .tv_sec = 5 }; if (setsockopt(socket_fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout))) err(1, "PF_ROUTE timeout");
  Message current = {0}; int has_current = 0;
  if (preflight) {
    has_current = query(socket_fd, &current);
    char filename[PATH_MAX]; owned_path(filename, sizeof(filename), argv[2], ".preflight.bin"); save_route(filename, &current);
    observe(argv[2], "preflight", 1, &current, &current);
    printf("{\"baselineSealed\":false,\"exactRouteExisted\":%s,\"interfaceIndex\":%u,\"flags\":%d,\"expiryEpochSeconds\":%lld,\"current\":", has_current ? "true" : "false", current.header.rtm_index, current.header.rtm_flags, (long long)current.header.rtm_rmx.rmx_expire);
    describe(stdout, &current); fputs("}\n", stdout);
    close(socket_fd); return 0;
  }
  if (snapshot) {
    char filename[PATH_MAX]; owned_path(filename, sizeof(filename), argv[2], ".preflight.bin");
    Message before = load(filename), previous = {0};
    const uint64_t deadline = monotonic_milliseconds() + 2000u;
    uint64_t previous_at = 0; unsigned previous_attempt = 0; int previous_exists = 0;
    observation_deadline = deadline;
    for (unsigned attempt = 1; attempt <= 16; attempt++) {
      if (monotonic_milliseconds() >= deadline) break;
      memset(&current, 0, sizeof(current)); has_current = query(socket_fd, &current);
      uint64_t observed_at = observe(argv[2], "precapture", attempt, &before, &current);
      if (!precapture_identity(&before, &current)) errx(1, "Original route presence, owner or non-expiry identity changed before its first seal");
      uint64_t now = monotonic_milliseconds();
      if (previous_attempt && observed_at >= previous_at + 100u && now <= deadline
        && has_current == previous_exists && (!has_current || same_identity(&previous, &current))) {
        save_route(argv[2], &current);
        printf("{\"baselineSealed\":true,\"baselineAcquiredAfterTopology\":true,\"exactRouteExisted\":%s,\"interfaceIndex\":%u,\"flags\":%d,\"expiryEpochSeconds\":%lld,"
          "\"stablePair\":{\"firstAttempt\":%u,\"secondAttempt\":%u,\"firstMonotonicMilliseconds\":%llu,\"secondMonotonicMilliseconds\":%llu,"
          "\"deadlineMonotonicMilliseconds\":%llu,\"completeIdentityEqual\":%s,\"bothAbsent\":%s}}\n",
          has_current ? "true" : "false", current.header.rtm_index, current.header.rtm_flags, (long long)current.header.rtm_rmx.rmx_expire,
          previous_attempt, attempt, (unsigned long long)previous_at, (unsigned long long)observed_at, (unsigned long long)deadline,
          has_current ? "true" : "false", has_current ? "false" : "true");
        close(socket_fd); return 0;
      }
      previous = current; previous_exists = has_current; previous_at = observed_at; previous_attempt = attempt;
      if (attempt == 16 || now >= deadline || deadline - now <= 100u) break;
      if (usleep(100000)) err(1, "Wait for first-seal full identity stability");
    }
    errx(1, "Original route did not produce a stable full identity before its first seal");
  }
  Message original = load(argv[2]); int has_original = exact(&original);
  unsigned owned_index = if_nametoindex(argv[3]);
  if (install) {
    if (owned_index != bound_index) errx(1, "The created feth interface identity changed before install");
    mutation_state(argv, bound_index, "preparing", 0);
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
    // Only exact observations of the fixed saved baseline can admit mutation.
    // No tolerance, alternate baseline, or second ADD/DELETE attempt exists.
    if (!observe_original(socket_fd, argv[2], "install", &original, &current, &has_current)) errx(1, "Limited broadcast route changed after capture");
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
    has_current = query(socket_fd, &current);
    observe(argv[2], "restore", 1, &original, &current);
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
    if (!observe_original(socket_fd, argv[2], "restore-final", &original, &current, &has_current)) errx(1, "Original route identity was not restored");
    printf("{\"restored\":true,\"exactRouteExisted\":%s,\"interfaceIndex\":%u}\n", has_current ? "true" : "false", current.header.rtm_index);
  }
  close(socket_fd); return 0;
}
`;

const helper = path.join(directory, 'broadcast-route-owner'), savedRoute = path.join(directory, 'broadcast-route-original.bin');
const preflightRoute = savedRoute + '.preflight.bin';
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
  if (record.preflightRouteSha256) assert.equal(sha(await readFile(preflightRoute)), record.preflightRouteSha256,
    'The independent preflight bytes changed.');
  if (record.originalRouteSha256) assert.equal(sha(await readFile(savedRoute)), record.originalRouteSha256,
    'The once-sealed route bytes changed.');
  const prefix = path.basename(savedRoute) + '.before-';
  const previous = new Map((record.routeObservations ?? []).map(entry => [entry.path, entry.sha256]));
  const observations = record.routeObservations = [], failures = [];
  for (const name of (await readdir(directory)).filter(value => value.startsWith(prefix)).sort()) {
    const match = /^broadcast-route-original\.bin\.before-(preflight|precapture|install|restore|restore-final)-(\d+)-attempt-([1-9]|1[0-6])\.(bin|json)(\.pending-\d+)?$/u.exec(name);
    assert.ok(match, 'Unexpected route observation filename.');
    const absolute = path.join(directory, name), stat = await lstat(absolute);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'A route observation must be an exclusive regular file.');
    const bytes = await readFile(absolute), entry = { path: absolute, size: bytes.length, sha256: sha(bytes),
      operation: match[1], helperPid: Number(match[2]), attempt: Number(match[3]), format: match[4], complete: !match[5],
      candidateHead: record.candidateHead, preflightRouteSha256: record.preflightRouteSha256, savedRouteSha256: record.originalRouteSha256 };
    observations.push(entry);
    if (previous.has(absolute) && previous.get(absolute) !== entry.sha256)
      failures.push(new Error('A previously captured route observation changed: ' + absolute));
    if (!entry.complete) { failures.push(new Error('An incomplete route observation remains: ' + absolute)); continue; }
    if (entry.format === 'json') {
      entry.value = JSON.parse(bytes);
      assert.equal(entry.value.operation, entry.operation); assert.equal(entry.value.attempt, entry.attempt);
      assert.equal(entry.value.readOnlyObservation, true);
      const unsealed = ['preflight', 'precapture'].includes(entry.operation);
      assert.equal(entry.value.baselineSealed, !unsealed);
      assert.equal(entry.value.comparisonReference, unsealed ? 'unsealed-preflight' : 'sealed-original');
      for (const name of ['monotonicMilliseconds', 'deadlineMonotonicMilliseconds'])
        assert.ok(Number.isSafeInteger(entry.value[name]) && entry.value[name] >= 0);
    }
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
async function observeCleanupCurrentRoute(stage) {
  const probe = path.join(directory, 'cleanup-current-' + stage + '-' + randomBytes(16).toString('hex'));
  const observation = { stage, probe, observedAt: new Date().toISOString(), artifacts: [] }, failures = [];
  (record.cleanupCurrentRouteObservations ??= []).push(observation);
  try {
    assert.equal(sha(await readFile(helper)), record.helperSha256, 'The owned routing helper changed before its current-route observation.');
    observation.stdout = await mutate('/usr/bin/sudo', [helper, 'preflight', probe, record.interface, record.address], { cleanup: true });
    observation.value = JSON.parse(observation.stdout);
  } catch (error) { observation.error = errorRecord(error); failures.push(error); }
  try {
    const prefix = path.basename(probe) + '.';
    for (const name of (await readdir(directory)).filter(value => value.startsWith(prefix)).sort()) {
      try {
        const absolute = path.join(directory, name), stat = await lstat(absolute);
        assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'A current-route observation must be an owned regular file.');
        const bytes = await readFile(absolute);
        observation.artifacts.push({ path: absolute, size: bytes.length, sha256: sha(bytes),
          regularFile: true, symbolicLink: false, device: stat.dev, inode: stat.ino });
      } catch (error) { failures.push(error); }
    }
    if (!failures.length) {
      assert.ok(observation.artifacts.some(entry => entry.path === probe + '.preflight.bin'), 'The current-route raw query receipt is missing.');
      for (const extension of ['bin', 'json']) assert.ok(observation.artifacts.some(entry =>
        entry.path.startsWith(probe + '.before-preflight-') && entry.path.endsWith('-attempt-1.' + extension)),
      'The complete current-route ' + extension + ' observation is missing.');
    }
  } catch (error) { failures.push(error); }
  observation.errors = failures.map(errorRecord);
  try { await publish(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, 'The current route could not be completely observed.', { cause: failures[0] });
  return observation;
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
    let noMutationProved = false, currentOutsideOwnedInterfaces = false;
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
      } catch (error) {
        failures.push(error);
        if (helperTrusted && record.createdInterfaces.length) {
          try {
            assert.equal(sha(await readFile(savedRoute)), record.originalRouteSha256, 'The captured route changed before its current-route observation.');
            await readInstallationState();
            // This separate, unsealed probe only reads the current route. It
            // never replaces the saved baseline or attempts another mutation.
            const observation = await observeCleanupCurrentRoute('before'), observed = observation.value, current = observed.current;
            record.currentRouteAfterFailedRestore = observation;
            assert.equal(observed.baselineSealed, false);
            assert.equal(observed.exactRouteExisted, true, 'An exact current route is required before independently releasing its former interfaces.');
            assert.equal(current?.exact, true);
            assert.ok(Number.isInteger(current.interfaceIndex) && current.interfaceIndex > 0 && current.interfaceIndex <= 65535);
            const ownedInterfaces = record.createdInterfaces.map(name => {
              const index = record.interfaceIdentities[name];
              assert.ok(Number.isInteger(index) && index > 0 && index <= 65535,
                'A current route cannot release an interface without its captured kernel index.');
              return { name, index };
            });
            const outsideOwned = ownedInterfaces.every(({ index }) => index !== current.interfaceIndex);
            record.interfaceCleanupAuthorization = { beforeCleanupCurrentInterfaceIndex: current.interfaceIndex,
              ownedInterfaces, beforeCleanupRouteOutsideOwned: outsideOwned };
            await publish();
            currentOutsideOwnedInterfaces = outsideOwned;
          } catch (observationError) { failures.push(observationError); }
        }
      }
    }
    try { await captureRouteObservations(); } catch (error) { failures.push(error); }
    // A failed restoration still preserves any interface referenced by the
    // current route. A verified foreign route no longer needs our feth pair.
    const interfacesCanBeReleased = record.routeRestored === true || !record.installationStateCreated || noMutationProved || currentOutsideOwnedInterfaces;
    if (interfacesCanBeReleased && helperTrusted) for (const name of [...record.createdInterfaces].reverse()) {
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
    if (currentOutsideOwnedInterfaces) {
      try {
        const after = await observeCleanupCurrentRoute('after'), before = record.currentRouteAfterFailedRestore;
        record.currentRouteAfterInterfaceCleanup = after;
        record.interfaceCleanupRouteComparison = { beforeProbe: before.probe, afterProbe: after.probe,
          completeDescriptionsEqual: before.stdout === after.stdout };
        await publish();
      } catch (error) { failures.push(error); }
    }
    const observeFinal = (field, read) => {
      try { return record[field] = read(); }
      catch (error) { record[field] = null; failures.push(error); }
    };
    const cleanupInterfaces = observeFinal('cleanupInterfaces', interfaces);
    observeFinal('cleanupRoutes', routes);
    const finalDefaultRoute = observeFinal('defaultRouteAfter', defaultRoute);
    if (record.defaultRoute && finalDefaultRoute !== undefined) {
      try { assert.deepEqual(defaultIdentity(finalDefaultRoute), defaultIdentity(record.defaultRoute), 'The IPv4 default route changed.'); }
      catch (error) { failures.push(error); }
    }
    if (cleanupInterfaces !== undefined) for (const name of [...(record.destroyedInterfaces ?? []), ...(record.alreadyAbsentInterfaces ?? [])]) {
      try { assert.ok(!cleanupInterfaces.split('\n').some(line => line.startsWith(name + ':')), 'An owned feth interface remained after cleanup.'); }
      catch (error) { failures.push(error); }
    }
    record.cleanupCompleted = !failures.length; record.cleanedAt = new Date().toISOString();
    try { await publish(); } catch (error) { record.cleanupCompleted = false; failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'The owned broadcast topology could not be fully restored.', { cause: failures[0] });
  })();
}
if (mode === 'cleanup') {
  try { record = JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') process.exit(0); throw error; }
  assert.equal(record.schemaVersion, 3, 'Cleanup requires the corresponding owned-topology receipt.');
  try { await restore(); }
  catch (error) {
    record.cleanupError = errorRecord(error);
    try { await publish(); }
    catch (publicationError) { throw new AggregateError([error, publicationError], 'Broadcast restoration and cleanup receipt publication failed.', { cause: error }); }
    throw error;
  }
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
  await mutate('/usr/bin/clang', ['-std=c11', '-Wall', '-Wextra', '-O2', sourcePath, '-o', helper, '-lproc']); record.helperSha256 = sha(await readFile(helper)); await publish();
  record.preflight = JSON.parse(await mutate('/usr/bin/sudo', [helper, 'preflight', savedRoute, record.interface, record.address]));
  assert.equal(record.preflight.baselineSealed, false);
  record.preflightRouteSha256 = sha(await readFile(preflightRoute));
  await captureRouteObservations(); await publish();
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
  assert.deepEqual(defaultIdentity(defaultRoute()), defaultIdentity(record.defaultRoute), 'Creating the owned topology changed the default route.');
  assert.equal(sha(await readFile(helper)), record.helperSha256, 'The owned routing helper changed before the first seal.');
  assert.equal(sha(await readFile(preflightRoute)), record.preflightRouteSha256, 'The independent preflight changed before the first seal.');
  record.original = JSON.parse(await mutate('/usr/bin/sudo', [helper, 'snapshot', savedRoute, record.interface, record.address]));
  assert.equal(record.original.baselineSealed, true); assert.equal(record.original.baselineAcquiredAfterTopology, true);
  record.originalRouteSha256 = sha(await readFile(savedRoute));
  await captureRouteObservations();
  const pairEvidence = record.original.stablePair;
  assert.ok(Number.isInteger(pairEvidence.firstAttempt) && pairEvidence.firstAttempt >= 1);
  assert.equal(pairEvidence.secondAttempt, pairEvidence.firstAttempt + 1); assert.ok(pairEvidence.secondAttempt <= 16);
  assert.ok(pairEvidence.secondMonotonicMilliseconds - pairEvidence.firstMonotonicMilliseconds >= 100);
  assert.ok(pairEvidence.secondMonotonicMilliseconds <= pairEvidence.deadlineMonotonicMilliseconds);
  const samples = [pairEvidence.firstAttempt, pairEvidence.secondAttempt].map(attempt => {
    const sample = record.routeObservations.find(entry => entry.operation === 'precapture' && entry.format === 'json' && entry.attempt === attempt);
    assert.ok(sample?.complete, 'A stable pair must bind two real complete precapture observations.'); return sample;
  });
  assert.equal(samples[0].value.monotonicMilliseconds, pairEvidence.firstMonotonicMilliseconds);
  assert.equal(samples[1].value.monotonicMilliseconds, pairEvidence.secondMonotonicMilliseconds);
  assert.equal(samples[0].helperPid, samples[1].helperPid, 'Both stable observations must belong to the same actual snapshot process.');
  for (const sample of samples) assert.equal(sample.value.deadlineMonotonicMilliseconds, pairEvidence.deadlineMonotonicMilliseconds);
  const completeIdentity = value => value === null ? null : { exact: value.exact, interfaceIndex: value.interfaceIndex,
    flagsWithoutDone: value.flagsWithoutDone, metrics: value.metrics, addresses: value.addresses };
  assert.deepEqual(completeIdentity(samples[0].value.current), completeIdentity(samples[1].value.current));
  assert.equal(pairEvidence.bothAbsent, samples[1].value.current === null);
  assert.equal(pairEvidence.completeIdentityEqual, samples[1].value.current !== null);
  const selectedBytes = record.routeObservations.find(entry => entry.operation === 'precapture' && entry.format === 'bin'
    && entry.helperPid === samples[1].helperPid && entry.attempt === pairEvidence.secondAttempt);
  assert.ok(selectedBytes?.complete); assert.equal(selectedBytes.sha256, record.originalRouteSha256);
  assert.ok((await readFile(selectedBytes.path)).equals(await readFile(savedRoute)), 'The first seal must contain the actual selected raw message.');
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
