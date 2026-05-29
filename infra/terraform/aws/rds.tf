resource "aws_db_subnet_group" "main" {
  name       = "${local.name}-pg"
  subnet_ids = aws_subnet.private[*].id
  tags       = local.tags
}

resource "aws_security_group" "db" {
  name        = "${local.name}-db"
  description = "Postgres access"
  vpc_id      = aws_vpc.main.id

  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.app.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = local.tags
}

resource "aws_db_instance" "main" {
  identifier             = "${local.name}-pg"
  engine                 = "postgres"
  engine_version         = "16.3"
  instance_class         = "db.t4g.small"
  allocated_storage      = 20
  storage_encrypted      = true
  db_name                = "clawreview"
  username               = var.db_username
  password               = var.db_password
  db_subnet_group_name   = aws_db_subnet_group.main.name
  vpc_security_group_ids = [aws_security_group.db.id]
  skip_final_snapshot    = true
  publicly_accessible    = false
  apply_immediately      = true
  backup_retention_period = 7
  tags = local.tags
}
