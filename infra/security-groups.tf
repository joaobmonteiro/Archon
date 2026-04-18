resource "aws_security_group" "alb" {
  name        = "${var.name_prefix}-alb"
  description = "Ingress for the Archon ALB."
  vpc_id      = aws_vpc.main.id

  ingress {
    description = "HTTPS from the public internet (or narrowed via var.alb_ingress_cidrs)."
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.alb_ingress_cidrs
  }

  ingress {
    description = "HTTP — redirected to HTTPS by the listener."
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = var.alb_ingress_cidrs
  }

  egress {
    description = "All outbound (to ECS tasks)."
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.name_prefix}-alb"
  }
}

resource "aws_security_group" "ecs" {
  name        = "${var.name_prefix}-ecs"
  description = "ECS host / task traffic."
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "App port from the ALB only."
    from_port       = var.app_port
    to_port         = var.app_port
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    description = "All outbound (Anthropic / OpenAI / GitHub / RDS / ECR / CloudWatch)."
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.name_prefix}-ecs"
  }
}

resource "aws_security_group" "rds" {
  name        = "${var.name_prefix}-rds"
  description = "Aurora Postgres — only reachable from the ECS host."
  vpc_id      = aws_vpc.main.id

  ingress {
    description     = "Postgres from ECS host."
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs.id]
  }

  tags = {
    Name = "${var.name_prefix}-rds"
  }
}
