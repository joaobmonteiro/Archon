resource "aws_db_subnet_group" "aurora" {
  name       = "${var.name_prefix}-aurora"
  subnet_ids = aws_subnet.private[*].id

  tags = {
    Name = "${var.name_prefix}-aurora"
  }
}

resource "random_password" "db_master" {
  length  = 32
  special = false # keep URL-safe so we can interpolate into DATABASE_URL
}

resource "aws_secretsmanager_secret" "db_master_password" {
  name                    = "${var.name_prefix}/db/master-password"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "db_master_password" {
  secret_id     = aws_secretsmanager_secret.db_master_password.id
  secret_string = random_password.db_master.result
}

resource "aws_rds_cluster" "aurora" {
  cluster_identifier     = "${var.name_prefix}-aurora"
  engine                 = "aurora-postgresql"
  engine_mode            = "provisioned"
  engine_version         = var.db_engine_version
  database_name          = var.db_name
  master_username        = var.db_master_username
  master_password        = random_password.db_master.result
  db_subnet_group_name   = aws_db_subnet_group.aurora.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  storage_encrypted      = true
  deletion_protection    = var.enable_deletion_protection
  skip_final_snapshot    = !var.enable_deletion_protection
  backup_retention_period = 7

  serverlessv2_scaling_configuration {
    min_capacity = var.db_min_capacity
    max_capacity = var.db_max_capacity
  }

  # Password is kept fresh via the Secrets Manager secret; Terraform's copy is
  # replaced by random_password on any rotation.
  lifecycle {
    ignore_changes = [master_password]
  }
}

resource "aws_rds_cluster_instance" "aurora" {
  identifier                   = "${var.name_prefix}-aurora-1"
  cluster_identifier           = aws_rds_cluster.aurora.id
  instance_class               = "db.serverless"
  engine                       = aws_rds_cluster.aurora.engine
  engine_version               = aws_rds_cluster.aurora.engine_version
  availability_zone            = local.primary_az
  publicly_accessible          = false
  performance_insights_enabled = true
}

# The DATABASE_URL the container actually reads.
resource "aws_secretsmanager_secret" "database_url" {
  name                    = "${var.name_prefix}/database-url"
  recovery_window_in_days = 0
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id = aws_secretsmanager_secret.database_url.id
  secret_string = format(
    "postgresql://%s:%s@%s:5432/%s",
    var.db_master_username,
    random_password.db_master.result,
    aws_rds_cluster.aurora.endpoint,
    var.db_name,
  )
}
