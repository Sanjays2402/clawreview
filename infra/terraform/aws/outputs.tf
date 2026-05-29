output "alb_dns" {
  value = aws_lb.main.dns_name
}

output "db_address" {
  value = aws_db_instance.main.address
}

output "redis_address" {
  value = aws_elasticache_cluster.main.cache_nodes[0].address
}
