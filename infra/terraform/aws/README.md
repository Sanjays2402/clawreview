# AWS Terraform skeleton

Provisions VPC, public/private subnets, RDS Postgres, ElastiCache Redis,
ECS Fargate, and an ALB. Intentionally light on DNS and TLS so it slots
into whatever Route 53 and ACM modules you already use.

```
terraform init
terraform plan -var="db_password=$(openssl rand -hex 16)"
terraform apply
```

The `image_server` and `image_dashboard` variables point at the GHCR images
built from `infra/docker/Dockerfile.{server,dashboard}`.
