# ECS-Optimized Amazon Linux 2023 AMI (updated on each apply).
data "aws_ssm_parameter" "ecs_ami" {
  name = "/aws/service/ecs/optimized-ami/amazon-linux-2023/recommended/image_id"
}

locals {
  user_data = <<-BASH
    #!/bin/bash
    set -euxo pipefail

    CLUSTER="${aws_ecs_cluster.main.name}"
    REGION="${var.aws_region}"
    VOLUME_ID="${aws_ebs_volume.archon.id}"
    MOUNT_POINT="/mnt/archon"

    # Register with the ECS cluster.
    {
      echo "ECS_CLUSTER=$CLUSTER"
      echo "ECS_ENABLE_TASK_IAM_ROLE=true"
      echo "ECS_CONTAINER_STOP_TIMEOUT=2m"
    } >> /etc/ecs/ecs.config

    # IMDSv2 — get this instance id.
    TOKEN=$(curl -sS -X PUT "http://169.254.169.254/latest/api/token" \
      -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
    INSTANCE_ID=$(curl -sS -H "X-aws-ec2-metadata-token: $TOKEN" \
      http://169.254.169.254/latest/meta-data/instance-id)

    # If the volume is still attached to a gone-but-not-detached instance, force detach.
    for _ in $(seq 1 60); do
      STATE=$(aws ec2 describe-volumes --region "$REGION" \
        --volume-ids "$VOLUME_ID" --query 'Volumes[0].State' --output text || echo "err")
      ATTACHED_TO=$(aws ec2 describe-volumes --region "$REGION" \
        --volume-ids "$VOLUME_ID" --query 'Volumes[0].Attachments[0].InstanceId' \
        --output text 2>/dev/null || echo "None")
      if [ "$STATE" = "available" ]; then
        break
      fi
      if [ "$STATE" = "in-use" ] && [ "$ATTACHED_TO" = "$INSTANCE_ID" ]; then
        break
      fi
      if [ "$STATE" = "in-use" ] && [ "$ATTACHED_TO" != "$INSTANCE_ID" ]; then
        aws ec2 detach-volume --region "$REGION" --volume-id "$VOLUME_ID" --force || true
      fi
      sleep 5
    done

    # Attach if not already on this instance.
    CUR=$(aws ec2 describe-volumes --region "$REGION" \
      --volume-ids "$VOLUME_ID" --query 'Volumes[0].Attachments[0].InstanceId' \
      --output text 2>/dev/null || echo "None")
    if [ "$CUR" != "$INSTANCE_ID" ]; then
      aws ec2 attach-volume --region "$REGION" \
        --volume-id "$VOLUME_ID" --instance-id "$INSTANCE_ID" --device /dev/sdf
    fi

    # Nitro instances expose EBS volumes under /dev/disk/by-id with the volume id in the path.
    VOL_STRIPPED=$(echo "$VOLUME_ID" | tr -d '-')
    BY_ID="/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_$VOL_STRIPPED"
    for _ in $(seq 1 60); do
      if [ -e "$BY_ID" ]; then break; fi
      sleep 2
    done
    DEV=$(readlink -f "$BY_ID")

    if ! blkid "$DEV" >/dev/null 2>&1; then
      mkfs.ext4 -F "$DEV"
    fi

    mkdir -p "$MOUNT_POINT"
    if ! mountpoint -q "$MOUNT_POINT"; then
      mount "$DEV" "$MOUNT_POINT"
    fi

    UUID=$(blkid -s UUID -o value "$DEV")
    if ! grep -q "$UUID" /etc/fstab; then
      echo "UUID=$UUID $MOUNT_POINT ext4 defaults,nofail 0 2" >> /etc/fstab
    fi

    # Archon's Docker image runs as UID 1001 (appuser).
    chown -R 1001:1001 "$MOUNT_POINT"

    systemctl restart ecs || true
  BASH
}

resource "aws_launch_template" "ecs" {
  name_prefix            = "${var.name_prefix}-ecs-"
  image_id               = data.aws_ssm_parameter.ecs_ami.value
  instance_type          = var.ec2_instance_type
  key_name               = var.ec2_key_pair_name
  vpc_security_group_ids = [aws_security_group.ecs.id]
  user_data              = base64encode(local.user_data)

  iam_instance_profile {
    name = aws_iam_instance_profile.ec2_ecs_host.name
  }

  block_device_mappings {
    device_name = "/dev/xvda"
    ebs {
      volume_size           = 20
      volume_type           = "gp3"
      encrypted             = true
      delete_on_termination = true
    }
  }

  metadata_options {
    http_tokens                 = "required"
    http_endpoint               = "enabled"
    http_put_response_hop_limit = 2
  }

  tag_specifications {
    resource_type = "instance"
    tags = {
      Name = "${var.name_prefix}-ecs-host"
    }
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_autoscaling_group" "ecs" {
  name_prefix         = "${var.name_prefix}-asg-"
  min_size            = 1
  max_size            = 1
  desired_capacity    = 1
  vpc_zone_identifier = [aws_subnet.public[0].id] # primary AZ, matches EBS

  launch_template {
    id      = aws_launch_template.ecs.id
    version = "$Latest"
  }

  health_check_type         = "EC2"
  health_check_grace_period = 300

  tag {
    key                 = "Name"
    value               = "${var.name_prefix}-ecs-host"
    propagate_at_launch = true
  }

  tag {
    key                 = "AmazonECSManaged"
    value               = "true"
    propagate_at_launch = true
  }

  lifecycle {
    create_before_destroy = true
    ignore_changes        = [desired_capacity]
  }
}
