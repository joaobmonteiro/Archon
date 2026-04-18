resource "hcloud_volume" "data" {
  name     = "${var.name_prefix}-data"
  size     = var.volume_size
  location = var.location
  format   = "ext4"

  # To make destruction safer in production, uncomment:
  # lifecycle {
  #   prevent_destroy = true
  # }
}

locals {
  cloud_init = templatefile("${path.module}/cloud-init.yaml.tftpl", {
    domain           = var.domain
    acme_email       = var.acme_email
    archon_image     = var.archon_image
    deploy_pubkey    = trimspace(tls_private_key.ci_deploy.public_key_openssh)
    volume_device_id = hcloud_volume.data.id
  })
}

resource "hcloud_server" "archon" {
  name         = "${var.name_prefix}-vps"
  server_type  = var.server_type
  image        = var.server_image
  location     = var.location
  ssh_keys     = [hcloud_ssh_key.admin.id]
  user_data    = local.cloud_init
  firewall_ids = [hcloud_firewall.archon.id]

  public_net {
    ipv4_enabled = true
    ipv6_enabled = true
  }

  labels = {
    project = var.name_prefix
  }

  # Don't rebuild the server just because Hetzner rotates the base image
  # hash or we add/remove SSH keys later.
  lifecycle {
    ignore_changes = [image, ssh_keys]
  }
}

resource "hcloud_volume_attachment" "data" {
  volume_id = hcloud_volume.data.id
  server_id = hcloud_server.archon.id
  # cloud-init formats+mounts; skip the Hetzner auto-mount hook.
  automount = false
}
