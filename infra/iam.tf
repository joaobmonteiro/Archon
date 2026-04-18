# ---------- ECS task execution role ----------
# Used by the ECS agent to pull images, write logs, and fetch secrets
# *before* the container starts.

data "aws_iam_policy_document" "ecs_task_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ecs_task_execution" {
  name               = "${var.name_prefix}-ecs-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
}

resource "aws_iam_role_policy_attachment" "ecs_task_execution_managed" {
  role       = aws_iam_role.ecs_task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Allow the execution role to read the specific secrets we expose to the task.
data "aws_iam_policy_document" "ecs_task_execution_secrets" {
  statement {
    actions = [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
    ]
    resources = concat(
      [for s in aws_secretsmanager_secret.app : s.arn],
      [aws_secretsmanager_secret.database_url.arn],
    )
  }
}

resource "aws_iam_role_policy" "ecs_task_execution_secrets" {
  name   = "${var.name_prefix}-secrets-read"
  role   = aws_iam_role.ecs_task_execution.id
  policy = data.aws_iam_policy_document.ecs_task_execution_secrets.json
}

# ---------- ECS task role ----------
# Used by the running container. Archon doesn't call AWS APIs today, so this
# is mostly a placeholder; attach policies here if you add S3 uploads,
# CloudWatch metrics, etc.

resource "aws_iam_role" "ecs_task" {
  name               = "${var.name_prefix}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
}

# ---------- EC2 instance profile for ECS hosts ----------

data "aws_iam_policy_document" "ec2_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ec2_ecs_host" {
  name               = "${var.name_prefix}-ec2-ecs-host"
  assume_role_policy = data.aws_iam_policy_document.ec2_assume.json
}

resource "aws_iam_role_policy_attachment" "ec2_ecs_for_ec2" {
  role       = aws_iam_role.ec2_ecs_host.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonEC2ContainerServiceforEC2Role"
}

# SSM Session Manager — avoids the need for SSH + a keypair.
resource "aws_iam_role_policy_attachment" "ec2_ssm" {
  role       = aws_iam_role.ec2_ecs_host.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# EBS attach/describe — the user-data script re-attaches the persistent
# volume whenever the instance boots.
data "aws_iam_policy_document" "ec2_ebs_attach" {
  statement {
    actions = [
      "ec2:AttachVolume",
      "ec2:DetachVolume",
    ]
    resources = [
      aws_ebs_volume.archon.arn,
      "arn:aws:ec2:${data.aws_region.current.name}:${data.aws_caller_identity.current.account_id}:instance/*",
    ]
  }

  statement {
    actions = [
      "ec2:DescribeVolumes",
      "ec2:DescribeInstances",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "ec2_ebs_attach" {
  name   = "${var.name_prefix}-ebs-attach"
  role   = aws_iam_role.ec2_ecs_host.id
  policy = data.aws_iam_policy_document.ec2_ebs_attach.json
}

resource "aws_iam_instance_profile" "ec2_ecs_host" {
  name = "${var.name_prefix}-ec2-ecs-host"
  role = aws_iam_role.ec2_ecs_host.name
}
