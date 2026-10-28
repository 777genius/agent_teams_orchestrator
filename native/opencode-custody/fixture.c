#define _GNU_SOURCE
/* Neutral TCP fixture only. No providers, files, tools or user project access. */
#include <arpa/inet.h>
#include <errno.h>
#include <netinet/tcp.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>
#ifndef FIXTURE_MARKER
#define FIXTURE_MARKER "A"
#endif
static int authorized(const char *request) {
  const char *password = getenv("OPENCODE_SERVER_PASSWORD");
  if (!password || !*password) return 0;
  char plain[128], encoded[192];
  int length = snprintf(plain, sizeof(plain), "opencode:%s", password);
  if (length <= 0 || length >= (int)sizeof(plain)) return 0;
  const char *alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  unsigned written = 0;
  for (unsigned i = 0; i < (unsigned)length; i += 3) {
    unsigned a = (unsigned char)plain[i], b = i + 1 < (unsigned)length ? (unsigned char)plain[i + 1] : 0;
    unsigned c = i + 2 < (unsigned)length ? (unsigned char)plain[i + 2] : 0;
    encoded[written++] = alphabet[a >> 2]; encoded[written++] = alphabet[((a & 3) << 4) | (b >> 4)];
    encoded[written++] = i + 1 < (unsigned)length ? alphabet[((b & 15) << 2) | (c >> 6)] : '=';
    encoded[written++] = i + 2 < (unsigned)length ? alphabet[c & 63] : '=';
  }
  encoded[written] = 0;
  const char *header = strcasestr(request, "\r\nauthorization: Basic ");
  if (!header) return 0;
  header += strlen("\r\nauthorization: Basic ");
  return !strncmp(header, encoded, written) && header[written] == '\r' && header[written + 1] == '\n';
}
int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "--version")) { puts("1.18.34"); return 0; }
  unsigned port = 0;
  unsigned descendant_port = 0;
  int deferred = 0;
  for (int i = 1; i + 1 < argc; i++) if (!strcmp(argv[i], "--port")) port = (unsigned)strtoul(argv[i + 1], NULL, 10);
  for (int i = 1; i + 1 < argc; i++) if (!strcmp(argv[i], "--descendant-port")) descendant_port = (unsigned)strtoul(argv[i + 1], NULL, 10);
  for (int i = 1; i < argc; i++) if (!strcmp(argv[i], "--deferred-accept")) deferred = 10;
  if (!port || port > 65535) return 112;
  signal(SIGPIPE, SIG_IGN);
  int listener = socket(AF_INET, SOCK_STREAM, 0), one = 1;
  if (listener < 0) return 112;
  setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
  if (deferred && setsockopt(listener, IPPROTO_TCP, TCP_DEFER_ACCEPT, &deferred, sizeof(deferred))) return 112;
  struct sockaddr_in address = { .sin_family = AF_INET, .sin_port = htons((unsigned short)port), .sin_addr.s_addr = htonl(INADDR_LOOPBACK) };
  if (bind(listener, (struct sockaddr *)&address, sizeof(address)) || listen(listener, 8)) return 112;
  if (descendant_port) {
    pid_t child = fork(); if (child < 0) return 112;
    if (!child) {
      close(listener); if (setsid() < 0) return 112;
      int descendant = socket(AF_INET, SOCK_STREAM, 0);
      address.sin_port = htons((unsigned short)descendant_port);
      if (descendant < 0 || bind(descendant, (struct sockaddr *)&address, sizeof(address)) || listen(descendant, 4)) return 112;
      for (;;) { int accepted = accept(descendant, NULL, NULL); if (accepted >= 0) close(accepted); }
    }
  }
  for (;;) {
    if (listener < 0) { pause(); continue; }
    int client = accept(listener, NULL, NULL); if (client < 0) { if (errno == EINTR) continue; return 112; }
    char request[4096]; size_t used = 0;
    for (;;) {
      ssize_t bytes = read(client, request + used, sizeof(request) - used - 1);
      if (bytes <= 0) break;
      used += (size_t)bytes; request[used] = 0;
      if (strstr(request, "\r\n\r\n") || used == sizeof(request) - 1) break;
    }
    request[used] = 0;
    if (!authorized(request)) {
      const char denied[] = "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
      if (used) (void)write(client, denied, sizeof(denied) - 1);
      close(client); continue;
    }
    if (strstr(request, " /session/broken-body ")) {
      const char broken[] = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 999\r\nConnection: close\r\n\r\n{}";
      (void)write(client, broken, sizeof(broken) - 1); close(client); continue;
    }
    const char *body = strstr(request, " /global/health ") ? "{\"healthy\":true,\"version\":\"1.18.34\"}" :
      "{\"marker\":\"" FIXTURE_MARKER "\",\"mcp\":{\"fixture\":{\"headers\":{\"Authorization\":\"Bearer TEST-private-MCP-sentinel\"}}}}";
    char response[512]; int size = snprintf(response, sizeof(response), "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %zu\r\nConnection: close\r\n\r\n%s", strlen(body), body);
    if (used && size > 0 && size < (int)sizeof(response)) (void)write(client, response, (size_t)size);
    close(client);
    if (strstr(request, " /global/dispose ")) { close(listener); return 0; }
    if (strstr(request, " /close-listener ")) { close(listener); listener = -1; }
  }
}
