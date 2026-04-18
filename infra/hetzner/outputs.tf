output "server_ipv4" {
  value       = hcloud_server.archon.ipv4_address
  description = "Public IPv4 of the Hetzner server. Set this as the GitHub secret VPS_HOST."
}

output "server_ipv6" {
  value       = hcloud_server.archon.ipv6_address
  description = "Public IPv6 of the Hetzner server."
}

output "fqdn" {
  value       = var.domain
  description = "Domain the server answers on."
}

output "ssh_admin_command" {
  value       = "ssh archon@${hcloud_server.archon.ipv4_address}"
  description = "Admin SSH invocation (uses your admin_ssh_pubkey)."
}

output "ssh_deploy_private_key" {
  value       = tls_private_key.ci_deploy.private_key_openssh
  description = "Private key for the CI deploy user. Paste into the GitHub repo secret VPS_SSH_KEY."
  sensitive   = true
}

output "github_secrets_to_set" {
  value = {
    VPS_HOST    = hcloud_server.archon.ipv4_address
    VPS_SSH_KEY = "run: terraform output -raw ssh_deploy_private_key"
  }
  description = "GitHub repo secrets required by .github/workflows/deploy-vps.yml."
}
