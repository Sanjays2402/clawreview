# Rotating the GitHub App private key

Rotate the GitHub App private key once a quarter or when a key may have leaked.

1. In the GitHub App settings, generate a new private key. Download it.
2. Update the secret in your deployment:
   - Helm: `helm upgrade clawreview infra/helm/clawreview --reuse-values --set-file secrets.githubAppPrivateKey=./new-key.pem`
   - Terraform: rotate the Secrets Manager entry, then bounce the ECS service.
3. Confirm a new review runs successfully against a test PR.
4. Delete the old key from the GitHub App settings.

Roll back by reinstating the previous secret. Old installation tokens expire within an hour, so impact is bounded.
