# Admin key — your personal key; used for day-to-day SSH.
resource "hcloud_ssh_key" "admin" {
  name       = "${var.name_prefix}-admin"
  public_key = var.admin_ssh_pubkey
}

# CI deploy key — generated here, private part exported as a sensitive output
# for you to paste into the GitHub secret VPS_SSH_KEY. Public key is added to
# the archon user's authorized_keys via cloud-init.
resource "tls_private_key" "ci_deploy" {
  algorithm = "ED25519"
}
