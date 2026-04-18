# Persistent data volume for ~/.archon (worktrees, artifacts, logs, web-dist).
# This volume is AZ-scoped (primary AZ) and survives EC2 replacement.
resource "aws_ebs_volume" "archon" {
  availability_zone = local.primary_az
  size              = var.ebs_size_gb
  type              = "gp3"
  iops              = var.ebs_iops
  throughput        = var.ebs_throughput
  encrypted         = true

  tags = {
    Name = "${var.name_prefix}-data"
  }

  # In testing we want `terraform destroy` to tear everything down cleanly.
  # For production, add:
  #   lifecycle { prevent_destroy = true }
  # so you can't wipe clones/worktrees/artifacts by accident.
}
