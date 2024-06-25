#!/bin/bash

# Script to add the CDH CodeBuild Role to the IAM role trust relationships created by the CDK Toolkit stack.
# The CDK Toolkit stack is commonly done by running the bootstrap command. This script is necessary as it is
# not currently possible to add custom parameters to the boostrap template and the CodeBuild role must be allowed
# to assume the CDK roles for CDK deployment from CodePipeline.
#
# Usage: update-cdk-role-trust-policy.sh <AccountId> <CodeBuildRoleName>
#
# Arguments:
#   AccountId           AWS Account ID where the roles are created.
#   CodeBuildRoleName   The name of the CodeBuild role to be allowed to assume the CDK Toolkit roles.
#
# Example:
#   ./update-trust-relationships.sh 123456789012 env-CodeBuildRole
#
# Check if both arguments are provided
if [ "$#" -ne 2 ]; then
  echo "Usage: $0 <AccountId> <CodeBuildRoleName>"
  exit 1
fi

# Arguments
ACCOUNT_ID=$1
CODEBUILD_ROLE_NAME=$2
ROLE_ARN_TO_ALLOW="arn:aws:iam::$ACCOUNT_ID:role/$CODEBUILD_ROLE_NAME"
CDK_TOOLKIT_STACK_NAME="CDKToolkit"

# Get the list of IAM roles created by the CDK Toolkit stack
ROLE_NAMES=$(aws cloudformation describe-stack-resources \
  --stack-name $CDK_TOOLKIT_STACK_NAME \
  --query "StackResources[?ResourceType=='AWS::IAM::Role'].PhysicalResourceId" \
  --output text)

# Loop through each role and update the trust relationship
for ROLE_NAME in $ROLE_NAMES; do
  echo "Updating trust relationship for role: $ROLE_NAME"

  # Get the existing trust relationship policy document
  TRUST_POLICY=$(aws iam get-role --role-name $ROLE_NAME --query "Role.AssumeRolePolicyDocument" --output json)

  # Add the new role ARN to the trust policy
  UPDATED_TRUST_POLICY=$(echo $TRUST_POLICY | jq --arg ROLE_ARN "$ROLE_ARN_TO_ALLOW" '.Statement += [{"Effect": "Allow", "Principal": {"AWS": $ROLE_ARN}, "Action": "sts:AssumeRole"}]')

  # Update the trust relationship
  aws iam update-assume-role-policy --role-name $ROLE_NAME --policy-document "$UPDATED_TRUST_POLICY"
done