# Gray-cloud A record: Cloudflare is DNS-only, Caddy handles TLS directly via
# Let's Encrypt. Switching to orange-cloud (proxied) later requires Caddy
# origin certs + Full (strict) mode in Cloudflare — out of scope for v1.
resource "cloudflare_record" "archon" {
  zone_id = var.cloudflare_zone_id
  name    = var.domain
  type    = "A"
  content = hcloud_server.archon.ipv4_address
  ttl     = 60
  proxied = false
  comment = "Managed by Terraform (archon/hetzner)"
}
