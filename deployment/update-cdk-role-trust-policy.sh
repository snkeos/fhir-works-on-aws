#!/bin/bash

# Script to add the CodeBuild role to the IAM role trust relationships created by the CDK Toolkit stack.
# The CDK Toolkit stack is commonly done by running the bootstrap command. This script is necessary as it is
# not currently possible to add custom parameters to the bootstrap template and the CodeBuild role must be allowed
# to assume the CDK roles for CDK deployment from CodePipeline.
#
# Usage: update-cdk-role-trust-policy.sh <AccountId> <CodeBuildRoleName> <CdkToolkitStackName>
#
# Arguments:
#   AccountId           AWS Account ID where the roles are created.
#   CodeBuildRoleName   The name of the CodeBuild role to be allowed to assume the CDK Toolkit roles.
#   CdkToolkitStackName The name of the CDK Toolkit stack
#
# Example:
#   ./update-cdk-role-trust-policy.sh 123456789012 env-CodeBuildRole cdk-toolkit-int1-fhirworks

# Check if all arguments are provided
if [ "$#" -ne 3 ]; then
  echo "Usage: $0 <AccountId> <CodeBuildRoleName> <CdkToolkitStackName>"
  exit 1
fi

# Arguments
ACCOUNT_ID=$1
CODEBUILD_ROLE_NAME=$2
CDK_TOOLKIT_STACK_NAME=$3
ROLE_ARN_TO_ALLOW="arn:aws:iam::$ACCOUNT_ID:role/$CODEBUILD_ROLE_NAME"

# Function to check if a role already has the CodeBuild role's ARN in its trust policy
role_has_permission() {
  local role_name=$1
  local permission_arn=$2
  local trust_policy
  trust_policy=$(aws iam get-role --role-name "$role_name" --query "Role.AssumeRolePolicyDocument.Statement[?Principal.AWS == '$permission_arn']" --output json)
  if [ -n "$trust_policy" ] && [ "$trust_policy" != "[]" ]; then
    return 0 # Permission exists
  else
    return 1 # Permission does not exist
  fi
}

# Get the list of IAM roles created by the CDK Toolkit stack
CDK_ROLES=$(aws cloudformation describe-stack-resources \
  --stack-name "$CDK_TOOLKIT_STACK_NAME" \
  --query "StackResources[?ResourceType=='AWS::IAM::Role'].PhysicalResourceId" \
  --output text)

if [ -z "$CDK_ROLES" ]; then
  echo "No IAM roles found in stack $CDK_TOOLKIT_STACK_NAME"
  exit 1
fi

# Loop through each role and update the trust relationship
for ROLE_NAME in $CDK_ROLES; do
  echo "Updating trust relationship for role: $ROLE_NAME to allow CodeBuild Role to assume CDK roles"

  # Check if the role already has the permission
  if role_has_permission "$ROLE_NAME" "$ROLE_ARN_TO_ALLOW"; then
    echo "Role $ROLE_NAME already allows assumption by CodeBuild Role."
  else
    echo "Adding trust relationship to $ROLE_NAME"

    # Get the existing trust relationship policy document
    TRUST_POLICY=$(aws iam get-role --role-name "$ROLE_NAME" --query "Role.AssumeRolePolicyDocument" --output json)

    # Check if we successfully retrieved the trust policy
    if [ -z "$TRUST_POLICY" ]; then
      echo "Failed to get trust policy for role $ROLE_NAME"
      continue
    fi

    # Add the new role ARN to the trust policy
    UPDATED_TRUST_POLICY=$(echo "$TRUST_POLICY" | jq --arg ROLE_ARN "$ROLE_ARN_TO_ALLOW" '.Statement += [{"Effect": "Allow", "Principal": {"AWS": $ROLE_ARN}, "Action": "sts:AssumeRole"}]')

    # Update the trust relationship
    aws iam update-assume-role-policy --role-name "$ROLE_NAME" --policy-document "$UPDATED_TRUST_POLICY"
    if [ $? -ne 0 ]; then
      echo "Failed to update trust policy for role $ROLE_NAME"
    else
      echo "Successfully updated trust policy for role $ROLE_NAME"
    fi
  fi
done
