// Read-only packet/identity evidence for the separate macOS policy experiment.
// No explicit route, PF, feth, packet-injection or process-signal operation.
// libpcap owns its temporary capture-interface/descriptor lifecycle.
// Retain original DLT_PKTAP metadata bytes in the actual system classic pcap:
// https://github.com/apple-oss-distributions/libpcap/blob/0a45d0c75e2a0677df572773bf31b733670acb80/libpcap/sf-pcap.c
#include <sys/types.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/ioctl.h>
#include <net/if.h>
#include <net/bpf.h>
#include <pcap/dlt.h>
// Use the SDK BPF types/ioctls without libpcap's cut-down redeclarations.
#define PCAP_DONT_INCLUDE_PCAP_BPF_H
#include <pcap/pcap.h>
#include <err.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

// The hosted SDK omits Apple's pcap-util.h; link its exact declared SPI below.
extern int pcap_set_want_pktap(pcap_t *, int);

typedef struct { pcap_t *source; pcap_dumper_t *output; size_t bytes, packets; int limited; } Capture;
static const size_t byte_limit = 16u * 1024u * 1024u;
static uint64_t milliseconds(void) {
  struct timespec value; if (clock_gettime(CLOCK_MONOTONIC, &value)) err(2, "Read capture clock");
  return (uint64_t)value.tv_sec * 1000u + (uint64_t)value.tv_nsec / 1000000u;
}
static void packet(unsigned char *context, const struct pcap_pkthdr *header, const unsigned char *bytes) {
  Capture *capture = (Capture *)context;
  if ((size_t)header->caplen + 16u > byte_limit - capture->bytes) {
    capture->limited = 1; pcap_breakloop(capture->source); return;
  }
  pcap_dump((unsigned char *)capture->output, header, bytes);
  capture->bytes += (size_t)header->caplen + 16u; capture->packets++;
}
static unsigned number(const char *text) {
  char *end; errno = 0; unsigned long value = strtoul(text, &end, 10);
  if (errno || !*text || *end || !value || value > UINT_MAX) errx(2, "Invalid ordinary account identity");
  return (unsigned)value;
}
int main(int argc, char **argv) {
  if (argc == 3 && !strcmp(argv[1], "interface-index")) {
    if (strncmp(argv[2], "feth", 4)) errx(2, "Only a proof-owned feth index may be read");
    for (const char *digit = argv[2] + 4; *digit; digit++) if (*digit < '0' || *digit > '9') errx(2, "Invalid feth name");
    printf("{\"interfaceIndex\":%u}\n", if_nametoindex(argv[2])); return 0;
  }
  if (argc != 5 || strcmp(argv[1], "capture") || argv[2][0] != '/') errx(2, "Invalid read-only capture operation");
  if (geteuid() != 0) errx(2, "Opening all-interface BPF evidence requires root");
  const unsigned uid = number(argv[3]), gid = number(argv[4]);
  char error[PCAP_ERRBUF_SIZE]; pcap_t *source = pcap_create("pktap,all", error);
  if (!source) errx(2, "Create read-only pktap capture: %s", error);
  /* Request the actual SDK DLT_PKTAP metadata; the saved type is recorded too.
   * Metadata must be requested before activation; open_live already activates.
   * https://github.com/apple-oss-distributions/libpcap/blob/0a45d0c75e2a0677df572773bf31b733670acb80/libpcap/pcap-util.h#L198-L202
   */
  if (pcap_set_want_pktap(source, 1) || pcap_set_snaplen(source, 65535) ||
      pcap_set_promisc(source, 0) || pcap_set_timeout(source, 100) ||
      pcap_set_buffer_size(source, (int)byte_limit) || pcap_set_immediate_mode(source, 1)) {
    fprintf(stderr, "Configure read-only pktap capture: %s\n", pcap_geterr(source));
    pcap_close(source); return 2;
  }
  const int activation_status = pcap_activate(source);
  if (activation_status < 0) {
    fprintf(stderr, "Activate read-only pktap capture: %s\n", pcap_geterr(source));
    pcap_close(source); return 2;
  }
  if (activation_status > 0) fprintf(stderr, "Read-only capture activation warning: %s\n", pcap_geterr(source));
  if (pcap_datalink(source) != DLT_PKTAP) {
    fprintf(stderr, "Read-only capture has live datalink %d, not SDK DLT_PKTAP %d\n", pcap_datalink(source), DLT_PKTAP);
    pcap_close(source); return 2;
  }
  /* Apple's live PKTAP does not support protocol BPF expressions. Preserve
   * every original frame; the consumer binds the actual nonce and interface
   * metadata. Byte, duration and loss limits still reject incomplete evidence.
   */
  if (pcap_setnonblock(source, 1, error)) {
    fprintf(stderr, "Set read-only capture nonblocking: %s\n", error); pcap_close(source); return 2;
  }
  const int descriptor = pcap_get_selectable_fd(source);
  if (descriptor < 0) { fprintf(stderr, "Capture has no pollable descriptor\n"); pcap_close(source); return 2; }
  unsigned kernel_buffer_bytes = 0;
  if (ioctl(descriptor, BIOCGBLEN, &kernel_buffer_bytes)) {
    warn("Read actual capture buffer size"); pcap_close(source); return 2;
  }
  const int file = open(argv[2], O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600);
  if (file < 0) { warn("Create original packet evidence"); pcap_close(source); return 2; }
  if (fchown(file, uid, gid)) { warn("Bind packet evidence to its ordinary owner"); close(file); pcap_close(source); return 2; }
  FILE *stream = fdopen(file, "wb");
  if (!stream) { warn("Open packet evidence stream"); close(file); pcap_close(source); return 2; }
  char output_buffer[64u * 1024u];
  if (setvbuf(stream, output_buffer, _IOFBF, sizeof(output_buffer))) {
    warn("Buffer original packet evidence"); fclose(stream); pcap_close(source); return 2;
  }
  pcap_dumper_t *output = pcap_dump_fopen(source, stream);
  if (!output) { fprintf(stderr, "Open original pcap: %s\n", pcap_geterr(source)); fclose(stream); pcap_close(source); return 2; }
  Capture capture = {.source = source, .output = output, .bytes = 24};
  const uint64_t started = milliseconds(), deadline = started + 120000u;
  printf("{\"capturing\":true,\"pid\":%d,\"uid\":%u,\"datalink\":%d,\"pktapDatalink\":%d,\"activationStatus\":%d,\"byteLimit\":%zu,\"requestedBufferBytes\":%zu,\"actualKernelBufferBytes\":%u,\"immediateModeRequested\":true,\"outputBufferBytes\":%zu,\"durationLimitMilliseconds\":120000,\"monotonicMilliseconds\":%llu}\n",
    getpid(), (unsigned)getuid(), pcap_datalink(source), DLT_PKTAP, activation_status, byte_limit, byte_limit,
    kernel_buffer_bytes, sizeof(output_buffer), (unsigned long long)started); fflush(stdout);
  int stopping = 0, pending = 0, duration_limited = 0, capture_error = 0;
  for (;;) {
    if (milliseconds() >= deadline) { duration_limited = 1; break; }
    struct pollfd descriptors[2] = {{.fd = STDIN_FILENO, .events = POLLIN}, {.fd = descriptor, .events = POLLIN}};
    /* A bounded dispatch can leave packets in libpcap's user buffer after
     * the BPF descriptor stops being readable. Drain another bounded batch
     * before waiting, still checking stdin and the deadline on every pass.
     * https://github.com/apple-oss-distributions/libpcap/blob/0a45d0c75e2a0677df572773bf31b733670acb80/libpcap/pcap-bpf.c
     */
    int polled = poll(descriptors, 2, stopping || pending ? 0 : 100);
    if (polled < 0) { if (errno == EINTR) continue; capture_error = errno; break; }
    if (descriptors[0].revents & (POLLIN | POLLHUP | POLLERR | POLLNVAL)) stopping = 1;
    int count = pcap_dispatch(source, 16, packet, (unsigned char *)&capture);
    if (count == PCAP_ERROR) { fprintf(stderr, "Read packet evidence: %s\n", pcap_geterr(source)); capture_error = EIO; break; }
    if (capture.limited || count == PCAP_ERROR_BREAK || (stopping && !count)) break;
    pending = count > 0;
  }
  struct pcap_stat stats = {0}; const int stats_error = pcap_stats(source, &stats);
  if (stats_error) fprintf(stderr, "Read capture loss counters: %s\n", pcap_geterr(source));
  if (pcap_dump_flush(output) || ferror(stream) || fsync(file)) capture_error = errno ? errno : EIO;
  pcap_dump_close(output); pcap_close(source);
  printf("{\"capturing\":false,\"packets\":%zu,\"bytes\":%zu,\"received\":%u,\"dropped\":%u,\"interfaceDropped\":%u,\"statsError\":%d,\"captureErrno\":%d,\"byteLimitReached\":%s,\"durationLimitReached\":%s,\"eofRequested\":%s,\"monotonicMilliseconds\":%llu}\n",
    capture.packets, capture.bytes, stats.ps_recv, stats.ps_drop, stats.ps_ifdrop, stats_error, capture_error,
    capture.limited ? "true" : "false", duration_limited ? "true" : "false", stopping ? "true" : "false", (unsigned long long)milliseconds()); fflush(stdout);
  return stats_error || capture_error || capture.limited || duration_limited ? 2 : 0;
}
