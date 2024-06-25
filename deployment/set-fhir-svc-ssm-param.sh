#!/bin/bash

# Script to retrieve the FHIR server endpoint from the output of the FHIRworks stack for a given environment.
# The vlaue is added to the SSM Parameter store for reference by the CDH pipeline.
#
# Usage: set-fhir-svc-ssm-param.sh <Stage>
#
# Arguments:
#   StageName       Stage name of the FHIRworks deployment (int1-fhirworks, int2-fhirworks, ...).
#
# Example:
#   ./set-fhir-svc-ssm-param.sh int4-fhirworks
#
# Check if an environment is provided
if [ -z "$1" ]; then
  echo "Usage: $0 <StageName>"
  exit 1
fi

EXPORT_NAME="serviceEndpoint-$1"

# Retrieve the export value
SERVICE_ENDPOINT=$(aws cloudformation list-exports --query "Exports[?Name=='${EXPORT_NAME}'].Value" --output text)

# Check if the export value is found
if [ -z "${SERVICE_ENDPOINT}" ]; then
  echo "Export with name '${EXPORT_NAME}' not found."
  exit 1
fi

# Print the export value
aws ssm put-parameter --name "$STAGE_NAME-fhirworks-url" --value "$SERVICE_ENDPOINT" --type "String" --overwrite
