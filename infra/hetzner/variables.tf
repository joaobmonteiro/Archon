variable "name_prefix" {
  type        = string
  description = "Prefix for all resource names on Hetzner."
  default     = "archon"
}

# ---------- Compute ----------

variable "server_type" {
  type        = string
  description = "Hetzner server type. CPX32 = 4 vCPU / 8 GB / 160 GB NVMe / €13.99. CPX21 = 3 vCPU / 4 GB / 80 GB for lighter testing."
  default     = "cpx32"
}

variable "location" {
  type        = string
  description = "Hetzner location: nbg1 (Nuremberg), fsn1 (Falkenstein), hel1 (Helsinki)."
  default     = "nbg1"
}

variable "server_image" {
  type        = string
  description = "Hetzner base image. Ubuntu 24.04 is cloud-init native."
  default     = "ubuntu-24.04"
}

# ---------- Storage ----------

variable "volume_size" {
  type        = number
  description = "Hetzner Volume size in GB (minimum 10). Survives server rebuilds; holds .env, Postgres data, Caddy TLS certs, and Archon workspaces."
  default     = 50
}

# ---------- DNS + TLS ----------

variable "domain" {
  type        = string
  description = "FQDN the server will answer on (e.g. archon.example.com). Caddy requests a Let's Encrypt cert for it."
}

variable "acme_email" {
  type        = string
  description = "Email Let's Encrypt contacts about expiry. Required to avoid rate-limited anonymous ACME."
}

variable "cloudflare_zone_id" {
  type        = string
  description = "Cloudflare Zone ID for var.domain's apex. Find it in Cloudflare dashboard → Overview → API section."
}

# ---------- Access control ----------

variable "admin_ssh_pubkey" {
  type        = string
  description = "Your personal SSH public key. Installed on the server for the `archon` user."
}

variable "admin_cidrs" {
  type        = list(string)
  description = "CIDRs allowed to reach SSH (:22). Default is wide-open — narrow to office/VPN CIDRs once you're live."
  default     = ["0.0.0.0/0", "::/0"]
}

# ---------- Application ----------

variable "archon_image" {
  type        = string
  description = "GHCR image + tag to pull. Point at your fork's GHCR repo (e.g. ghcr.io/<you>/archon:latest) once you have your own builds."
  default     = "ghcr.io/coleam00/archon:latest"
}
