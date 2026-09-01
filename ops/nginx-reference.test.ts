import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_PORTABLE_ARCHIVE_BYTES } from "@/lib/portable/archive";
import { MAX_ATTACHMENT_BYTES } from "@/lib/store/store";

const root = process.cwd();
const vhost = readFileSync(path.join(root, "ops", "nginx", "brain.conf.example"), "utf8");
const edge = readFileSync(path.join(root, "ops", "nginx", "brain-edge-secret.conf.example"), "utf8");
const cloudflare = readFileSync(path.join(root, "ops", "nginx", "brain-cloudflare-ips.conf.example"), "utf8");

function block(location: string): string {
  const start = vhost.indexOf(`location ${location} {`);
  expect(start, `location ${location}`).toBeGreaterThan(-1);
  const end = vhost.indexOf("\n    }\n", start);
  expect(end, `location ${location} close`).toBeGreaterThan(-1);
  return vhost.slice(start, end);
}

describe("reference nginx vhost", () => {
  it("proxies to loopback 3020 and never trusts a client-supplied edge header", () => {
    expect(vhost).toContain("server 127.0.0.1:3020;");
    expect(block("/")).toContain('proxy_set_header X-Brain-Edge-Secret "";');
    expect(block("/")).toContain('proxy_set_header X-Brain-Rate-Source "";');
    expect(block("/")).toContain("proxy_set_header Upgrade $http_upgrade;");
    expect(block("/")).toContain("proxy_set_header Connection $brain_connection_upgrade;");
  });
  it("overwrites both trusted headers on the three public OAuth routes with an outer source limit", () => {
    for (const route of ["= /oauth/register", "= /oauth/token", "= /oauth/revoke"]) {
      expect(block(route)).toContain("proxy_set_header X-Brain-Edge-Secret $brain_edge_secret;");
      expect(block(route)).toContain("proxy_set_header X-Brain-Rate-Source $remote_addr;");
      expect(block(route)).toContain("limit_req zone=brain_oauth burst=5 nodelay;");
    }
    expect(vhost).toContain("include /etc/nginx/brain-edge-secret.conf;");
    expect(edge).toMatch(/^set \$brain_edge_secret "replace-with-the-64-hex-BRAIN_EDGE_RATE_SECRET";\n$/);
    expect(vhost).not.toMatch(/[0-9a-f]{64}/);
  });
  it("ships the real-ip stanza off, and never lets one run unpaired", () => {
    const live = (needle: string) =>
      vhost
        .split("\n")
        .map((line) => line.trim())
        .some((line) => !line.startsWith("#") && line.includes(needle));
    // Off by default: a self-hoster who is not behind Cloudflare must not
    // inherit a CF-Connecting-IP rule that mangles every client address he
    // has, and one who is behind it gets three lines to uncomment.
    expect(live("real_ip_header")).toBe(false);
    expect(vhost).toContain("# include /etc/nginx/brain-cloudflare-ips.conf;");
    expect(vhost).toContain("# real_ip_header CF-Connecting-IP;");
    expect(vhost).toContain("# real_ip_recursive on;");
    expect(vhost).toContain("# real_ip_header X-Forwarded-For;");
    // A real_ip_header with no trusted ranges lets a client forge its own
    // address, so the two can only ever be turned on together.
    if (live("real_ip_header")) {
      expect(live("set_real_ip_from") || live("brain-cloudflare-ips.conf")).toBe(true);
    }
    for (const line of cloudflare.trim().split("\n")) expect(line).toMatch(/^set_real_ip_from [0-9a-f.:/]+;$/);
  });
  it("redirects plain HTTP and hardens the TLS it terminates", () => {
    expect(vhost).toContain("listen 80;");
    expect(vhost).toContain("listen [::]:80;");
    expect(vhost).toContain("return 301 https://$host$request_uri;");
    expect(vhost).toContain("ssl_protocols TLSv1.2 TLSv1.3;");
    expect(vhost).toContain("ssl_prefer_server_ciphers off;");
    expect(vhost).toMatch(/\n    ssl_ciphers ECDHE[^\n]+;\n/);
    expect(vhost).toContain("ssl_session_tickets off;");
    expect(vhost).toContain("server_tokens off;");
    // One HSTS header, not two: the app sends its own and nginx replaces it,
    // so nginx's own 4xx/5xx answers carry it as well.
    expect(vhost).toContain("proxy_hide_header Strict-Transport-Security;");
    expect(vhost).toContain(
      'add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;',
    );
  });
  it("admits every body the app itself accepts", () => {
    // The example capped the whole server at 8m while the app accepted a
    // 25 MiB attachment and a 100 MiB portable archive, so a self-hoster who
    // followed it got a 413 on a valid upload. Read off the constants rather
    // than restated, so raising either one fails here first.
    const mib = (bytes: number) => bytes / (1024 * 1024);
    // Four-space indent: the server-level cap, not a location's own.
    const cap = /\n    client_max_body_size (\d+)m;\n/.exec(vhost);
    expect(cap, "server-level client_max_body_size").not.toBeNull();
    const serverCap = Number(cap?.[1]);
    expect(serverCap).toBeGreaterThan(mib(MAX_PORTABLE_ARCHIVE_BYTES));
    expect(serverCap).toBeGreaterThan(mib(MAX_ATTACHMENT_BYTES));
  });
  it("streams SSE unbuffered and admits 25 MiB Notion uploads unbuffered", () => {
    expect(block("= /api/events")).toContain("proxy_buffering off;");
    expect(block("= /api/events")).toContain("proxy_read_timeout 1h;");
    expect(block("= /api/mcp/notion-upload")).toContain("client_max_body_size 26m;");
    expect(block("= /api/mcp/notion-upload")).toContain("proxy_request_buffering off;");
    expect(block("= /api/mcp/notion-upload")).toContain("proxy_read_timeout 120s;");
    expect(block("= /api/mcp/notion-upload")).toContain("proxy_send_timeout 120s;");
  });
});
