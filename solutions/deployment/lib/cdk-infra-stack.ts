import {
  CfnCondition,
  CfnOutput,
  CfnParameter,
  CustomResource,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  StackProps
} from 'aws-cdk-lib';
import { UserPool } from 'aws-cdk-lib/aws-cognito';
import {
  ApiKeySourceType,
  AuthorizationType,
  CognitoUserPoolsAuthorizer,
  RestApi,
  EndpointType,
  LambdaIntegration,
  MethodLoggingLevel,
  AccessLogFormat,
  LogGroupLogDestination
} from 'aws-cdk-lib/aws-apigateway';
import { AttributeType, BillingMode, StreamViewType, Table, TableEncryption } from 'aws-cdk-lib/aws-dynamodb';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import {
  AnyPrincipal,
  Effect,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
  StarPrincipal
} from 'aws-cdk-lib/aws-iam';
import { Alias } from 'aws-cdk-lib/aws-kms';
import { Runtime, StartingPosition, Tracing } from 'aws-cdk-lib/aws-lambda';
import { DynamoEventSource, SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Bucket, BucketAccessControl, BucketEncryption, ObjectOwnership } from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { Queue, QueuePolicy } from 'aws-cdk-lib/aws-sqs';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { NodejsFunction, NodejsFunctionProps } from 'aws-cdk-lib/aws-lambda-nodejs';
import path from 'path';
import { NagSuppressions } from 'cdk-nag';
import KMSResources from './kms';
import ElasticSearchResources from './elasticsearch';
import SubscriptionsResources from './subscriptions';
import CognitoResources from './cognito';
import BulkExportResources from './bulkExport';
import BulkExportStateMachine from './bulkExportStateMachine';
import Backup from './backup';
import AlarmsResource from './alarms';
import JavaHapiValidator from './javaHapiValidator';

export interface FhirWorksStackProps extends StackProps {
  stage: string;
  stageType: string;
  region: string;

  enableSubscriptions: boolean;
  enableBackup: boolean;
  enableESHardDelete: boolean;
  enableSecurityLogging: boolean;

  useHapiValidator: boolean;

  enableMultiTenancy: boolean;
  grantAccessAllTenantsScope: string;
  useTenantSpecificUrl: boolean;
  tenantIdClaimPath: string;
  tenantIdClaimValuePrefix: string;

  logLevel: string;

  fhirVersion: string;

  igMemoryLimit: number;
  igMemorySize: number;
  igStorageSize: number;

  validateXHTML: boolean;

  patientCompartmentFileV3: string;
  patientCompartmentFileV4: string;

  oauthRedirect: string;
  extUserPoolId: string;
  extUserPoolClientId: string;
  extUserPoolDomain: string;

  corsOrigins: string;
  useApiKeys: boolean;
}

export default class FhirWorksStack extends Stack {
  javaHapiValidator: JavaHapiValidator | undefined;

  constructor(scope: Construct, id: string, props?: FhirWorksStackProps) {
    super(scope, id, props);

    // ServerlessIfElse re-write
    let cognitoScopes: string[] = ['openid', 'profile', 'aws.cognito.signin.user.admin'];
    if (props!.grantAccessAllTenantsScope !== "") {
      cognitoScopes.push(props!.grantAccessAllTenantsScope);
    }

    // If multitenancy supported and url specific tenant set, create tenant specific endpoints
    const tenantPrefix = (props!.enableMultiTenancy && props!.useTenantSpecificUrl) ? '/tenant/{tenantId}' : '';
    const serverEndpoint = `${tenantPrefix}/`; // fhirServer.events.0
    const proxyEndpoint = `${tenantPrefix}/{proxy+}`; // fhirServer.events.1
    const serverMetadata = `${tenantPrefix}/metadata`; // fhirServer.events.2

    // Define parameters
    const exportGlueWorkerType = new CfnParameter(this, 'exportGlueWorkerType', {
      type: 'String',
      default: 'G.2X',
      allowedValues: ['G.2X', 'G.1X'],
      description: 'Select the Glue worker type to run export jobs. Default is "G.2X"'
    });

    const exportGlueNumberWorkers = new CfnParameter(this, 'exportGlueNumberWorkers', {
      type: 'Number',
      default: 5,
      description: 'Number of Glue workers to use during an Export job.'
    });

    // define conditions here:
    const isDev = props!.stageType === 'dev';
    const isDevCondition = new CfnCondition(this, 'isDev', {
      expression: Fn.conditionEquals(props!.stage, 'dev')
    });
    const isMultiTenancyEnabled = props!.enableMultiTenancy;
    // if any external user pool properties are empty, then use default user pool
    const isUsingDefaultUserPool = props!.extUserPoolId !== '' || props!.extUserPoolClientId !== '' || props!.extUserPoolDomain !== '';
    // define other custom variables here
    const resourceTableName = `resource-db-${props!.stage}`;
    const exportRequestTableName = `export-request-${props!.stage}`;
    const exportRequestTableJobStatusIndex = `jobStatus-index`;

    // Create KMS Resources
    const kmsResources = new KMSResources(this, props!.region, props!.stage, this.account, props!.enableSecurityLogging);

    // Define ElasticSearch resources here:
    const elasticSearchResources = new ElasticSearchResources(
      this,
      this.stackName,
      props!.stage,
      this.account,
      this.partition,
      props!.region,
      isDev,
      kmsResources.elasticSearchKMSKey
    );

    // Start defining necessary resources
    const fhirLogsBucket = new Bucket(this, 'fhirLogsBucket', {
      encryption: BucketEncryption.S3_MANAGED,
      publicReadAccess: false,
      blockPublicAccess: {
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true
      },
      versioned: true,
      enforceSSL: true,
      objectOwnership: ObjectOwnership.OBJECT_WRITER
    });
    NagSuppressions.addResourceSuppressions(fhirLogsBucket, [
      {
        id: 'AwsSolutions-S1',
        reason: 'This is the logs bucket for access logs'
      },
      {
        id: 'HIPAA.Security-S3BucketLoggingEnabled',
        reason: 'This is the logs bucket for access logs',
      },
      {
        id: 'HIPAA.Security-S3DefaultEncryptionKMS',
        reason: 'bucket is encrypted by S3 Managed enryption',
      },
    ]);

    if (props!.useHapiValidator) {
      // deploy hapi validator stack
      // eslint-disable-next-line no-new
      this.javaHapiValidator = new JavaHapiValidator(this, 'javaHapiValidator', {
        region: props!.region,
        fhirVersion: props!.fhirVersion,
        stage: props!.stage,
        fhirLogsBucket,
        s3KMSKey: kmsResources.s3KMSKey,
        igMemoryLimit: props!.igMemoryLimit,
        igMemorySize: props!.igMemorySize,
        igStorageSize: props!.igStorageSize
      });
    }

    const resourceDynamoDbTable = new Table(this, resourceTableName, {
      partitionKey: {
        name: 'id',
        type: AttributeType.STRING
      },
      sortKey: {
        type: AttributeType.NUMBER,
        name: 'vid'
      },
      tableName: resourceTableName,
      stream: StreamViewType.NEW_AND_OLD_IMAGES,
      pointInTimeRecovery: true,
      encryption: TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: kmsResources.dynamoDbKMSKey,
      removalPolicy: RemovalPolicy.DESTROY,
      readCapacity: 30,
      writeCapacity: 30
    });
    resourceDynamoDbTable.addGlobalSecondaryIndex({
      indexName: 'activeSubscriptions',
      partitionKey: {
        name: '_subscriptionStatus',
        type: AttributeType.STRING
      },
      sortKey: {
        name: 'id',
        type: AttributeType.STRING
      },
      readCapacity: 30,
      writeCapacity: 30
    });

    const exportRequestDynamoDbTable = new Table(this, exportRequestTableName, {
      tableName: exportRequestTableName,
      partitionKey: {
        name: 'jobId',
        type: AttributeType.STRING
      },
      encryption: TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: kmsResources.dynamoDbKMSKey,
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecovery: true,
    });
    exportRequestDynamoDbTable.addGlobalSecondaryIndex({
      indexName: exportRequestTableJobStatusIndex,
      partitionKey: {
        name: 'jobStatus',
        type: AttributeType.STRING
      },
      sortKey: {
        name: 'jobOwnerId',
        type: AttributeType.STRING
      }
    });

    NagSuppressions.addResourceSuppressions(exportRequestDynamoDbTable, [
      {
        id: 'AwsSolutions-DDB3',
        reason: 'Backup not explicitly needed'
      }
    ]);

    // Create bulkExport Resources here:
    const bulkExportResources = new BulkExportResources(
      this,
      resourceDynamoDbTable,
      exportRequestDynamoDbTable,
      fhirLogsBucket,
      kmsResources.dynamoDbKMSKey,
      kmsResources.s3KMSKey,
      kmsResources.logKMSKey,
      props!.stage,
      props!.region,
      this.partition,
      exportGlueWorkerType,
      exportGlueNumberWorkers,
      isMultiTenancyEnabled
    );

    fhirLogsBucket.addToResourcePolicy(
      new PolicyStatement({
        sid: 'AllowSSLRequestsOnly',
        effect: Effect.DENY,
        principals: [new StarPrincipal()],
        actions: ['s3:*'],
        resources: [fhirLogsBucket.bucketArn, fhirLogsBucket.arnForObjects('*')],
        conditions: {
          Bool: {
            'aws:SecureTransport': 'false'
          }
        }
      })
    );

    const fhirBinaryBucket = new Bucket(this, 'fhirBinaryBucket', {
      serverAccessLogsBucket: fhirLogsBucket,
      serverAccessLogsPrefix: 'binary-acl',
      versioned: true,
      encryption: BucketEncryption.KMS,
      encryptionKey: kmsResources.s3KMSKey,
      removalPolicy: RemovalPolicy.RETAIN,
      blockPublicAccess: {
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true
      },
      objectOwnership: ObjectOwnership.OBJECT_WRITER
    });

    fhirBinaryBucket.addToResourcePolicy(
      new PolicyStatement({
        sid: 'AllowSSLRequestsOnly',
        effect: Effect.DENY,
        actions: ['s3:*'],
        principals: [new StarPrincipal()],
        resources: [fhirBinaryBucket.bucketArn, fhirBinaryBucket.arnForObjects('*')],
        conditions: {
          Bool: {
            'aws:SecureTransport': false
          }
        }
      })
    );

    // Create Subscriptions resources here:
    const subscriptionsResources = new SubscriptionsResources(
      this,
      props!.region,
      this.partition,
      props!.stage
    );

    // TODO: Replace creation of CognitoResources with existing ones pointed at by props
    // TODO: Adapt to create cognitoResouces if not using a pre-existing userpool
    // Create Cognito Resources here:
    // const cognitoResources = new CognitoResources(this, this.stackName, props!.oauthRedirect);
    // const defaultUserPool = isUsingDefaultUserPool ?
    //   cognitoResources.userPool :
    //   UserPool.fromUserPoolArn(
    //     this,
    //     'ExistingUserPool',
    //     `arn:${this.partition}:cognito-idp:${props!.region}:${this.account}:userpool/${props!.extUserPoolId}`
    //   );
    // const userPoolClient = isUsingDefaultUserPool ? cognitoResources.userPoolClient.ref : props!.extUserPoolClientId;
    const userPool = UserPool.fromUserPoolId(this, "UserPool", props!.extUserPoolId);

    const apiGatewayLogGroup = new LogGroup(this, 'apiGatewayLogGroup', {
      encryptionKey: kmsResources.logKMSKey,
      logGroupName: `/aws/api-gateway/fhir-service-${props!.stage}`,
      retention: RetentionDays.TEN_YEARS
    });

    const apiGatewayRestApi = new RestApi(this, 'apiGatewayRestApi', {
      apiKeySourceType: ApiKeySourceType.HEADER,
      restApiName: `${props!.stage}-fhir-service`,
      endpointConfiguration: {
        types: [EndpointType.EDGE]
      },
      deployOptions: {
        stageName: props!.stage,
        tracingEnabled: true,
        loggingLevel:
          props!.logLevel === MethodLoggingLevel.ERROR ? MethodLoggingLevel.ERROR : MethodLoggingLevel.INFO,
        accessLogFormat: AccessLogFormat.custom(
          '{"authorizer.claims.sub":"$context.authorizer.claims.sub","error.message":"$context.error.message","extendedRequestId":"$context.extendedRequestId","httpMethod":"$context.httpMethod","identity.sourceIp":"$context.identity.sourceIp","integration.error":"$context.integration.error","integration.integrationStatus":"$context.integration.integrationStatus","integration.latency":"$context.integration.latency","integration.requestId":"$context.integration.requestId","integration.status":"$context.integration.status","path":"$context.path","requestId":"$context.requestId","responseLatency":"$context.responseLatency","responseLength":"$context.responseLength","stage":"$context.stage","status":"$context.status"}'
        ),
        accessLogDestination: new LogGroupLogDestination(apiGatewayLogGroup)
      }
    });
    NagSuppressions.addResourceSuppressions(apiGatewayRestApi, [
      {
        id: 'AwsSolutions-APIG2',
        reason: 'Requests to the API Gateway are validated by the Lambda'
      }
    ]);
    NagSuppressions.addResourceSuppressionsByPath(
      this,
      `/fhir-service-${props!.stage}/apiGatewayRestApi/DeploymentStage.${props!.stage}/Resource`,
      [
        {
          id: 'AwsSolutions-APIG3',
          reason: 'Access is configured to be limited by a Usage Plan and API Key'
        },
        {
          id: 'HIPAA.Security-APIGWSSLEnabled',
          reason: 'Requests to the API Gateway are validated by the Lambda',
        },
        {
          id: 'HIPAA.Security-APIGWCacheEnabledAndEncrypted',
          reason: 'Requests are parsed for paths in the Lambda',
        },
      ]
    );

    // determine default user pool domain
    //const userPoolDomain = isUsingDefaultUserPool ? cognitoResources.userPoolDomain.ref : props!.extUserPoolDomain;
    const userPoolDomain = props!.extUserPoolDomain;
    const lambdaDefaultEnvVars = {
      API_URL: `https://${apiGatewayRestApi.restApiId}.execute-api.${props!.region}.amazonaws.com/${props!.stage
        }`,
      S3_KMS_KEY: kmsResources.s3KMSKey.keyArn,
      RESOURCE_TABLE: resourceDynamoDbTable.tableName,
      EXPORT_REQUEST_TABLE: exportRequestDynamoDbTable.tableName,
      EXPORT_REQUEST_TABLE_JOB_STATUS_INDEX: exportRequestTableJobStatusIndex,
      FHIR_BINARY_BUCKET: fhirBinaryBucket.bucketName,
      ELASTICSEARCH_DOMAIN_ENDPOINT: `https://${elasticSearchResources.elasticSearchDomain.domainEndpoint}`,
      OAUTH2_DOMAIN_ENDPOINT: `https://${userPoolDomain}.auth.${props!.region}.amazoncognito.com/oauth2`,
      EXPORT_RESULTS_BUCKET: bulkExportResources.bulkExportResultsBucket.bucketName,
      EXPORT_RESULTS_SIGNER_ROLE_ARN: bulkExportResources.exportResultsSignerRole.roleArn,
      CUSTOM_USER_AGENT: 'AwsSolution/SO0128/GH-v6.1.3',
      ENABLE_MULTI_TENANCY: `${props!.enableMultiTenancy}`,
      ENABLE_SUBSCRIPTIONS: `${props!.enableSubscriptions}`,
      LOG_LEVEL: props!.logLevel,
      LOGGING_MIDDLEWARE_KMS_KEY: kmsResources.securityLogKMSKey
        ? kmsResources.securityLogKMSKey.keyArn
        : 'ENCRYPTION_TURNED_OFF',
      ENABLE_SECURITY_LOGGING: `${props!.enableSecurityLogging}`,
      VALIDATE_XHTML: props?.validateXHTML ? 'true' : 'false',
    };

    const defaultLambdaBundlingOptions = {
      target: 'es2020'
    };
    const defaultBulkExportLambdaProps: NodejsFunctionProps = {
      timeout: Duration.seconds(30),
      memorySize: 192,
      runtime: Runtime.NODEJS_16_X,
      description: 'Start the Glue job for bulk export',
      role: bulkExportResources.glueJobRelatedLambdaRole,
      entry: path.join(__dirname, '../bulkExport/index.ts'),
      bundling: defaultLambdaBundlingOptions,
      environment: {
        ...lambdaDefaultEnvVars,
        GLUE_JOB_NAME: bulkExportResources.exportGlueJob.ref
      }
    };

    const startExportJobLambdaFunctionDLQ = new Queue(this, 'startExportJobLambdaFunctionDLQ', {
      retentionPeriod: Duration.days(14),
      encryptionMasterKey: Alias.fromAliasName(this, 'startExportJobLambdaFunctionDLQKey', 'alias/aws/sqs'),
    });
    NagSuppressions.addResourceSuppressions(startExportJobLambdaFunctionDLQ, [
      {
        id: 'AwsSolutions-SQS3',
        reason: 'This is a DLQ.',
      },
    ]);
    const startExportJobLambdaFunctionDLQHttpsOnlyPolicy = new QueuePolicy(
      this,
      'startExportJobLambdaFunctionDLQHttpsOnlyPolicy',
      {
        queues: [startExportJobLambdaFunctionDLQ],
      },
    );
    startExportJobLambdaFunctionDLQHttpsOnlyPolicy.document.addStatements(
      new PolicyStatement({
        effect: Effect.DENY,
        actions: ['SQS:*'],
        resources: [startExportJobLambdaFunctionDLQ.queueArn],
        principals: [new AnyPrincipal()],
        conditions: {
          Bool: {
            'aws:SecureTransport': false,
          },
        },
      }),
    );

    const startExportJobLambdaFunction = new NodejsFunction(this, 'startExportJobLambdaFunction', {
      ...defaultBulkExportLambdaProps,
      handler: 'startExportJobHandler',
      // reservedConcurrentExecutions: isDev ? 10 : 200,
      deadLetterQueue: startExportJobLambdaFunctionDLQ,
    });

    const stopExportJobLambdaFunctionDLQ = new Queue(this, 'stopExportJobLambdaFunctionDLQ', {
      retentionPeriod: Duration.days(14),
      encryptionMasterKey: Alias.fromAliasName(this, 'stopExportJobLambdaFunctionDLQKey', 'alias/aws/sqs'),
    });
    NagSuppressions.addResourceSuppressions(stopExportJobLambdaFunctionDLQ, [
      {
        id: 'AwsSolutions-SQS3',
        reason: 'This is a DLQ.',
      },
    ]);
    const stopExportJobLambdaFunctionDLQHttpsOnlyPolicy = new QueuePolicy(
      this,
      'stopExportJobLambdaFunctionDLQHttpsOnlyPolicy',
      {
        queues: [stopExportJobLambdaFunctionDLQ],
      },
    );
    stopExportJobLambdaFunctionDLQHttpsOnlyPolicy.document.addStatements(
      new PolicyStatement({
        effect: Effect.DENY,
        actions: ['SQS:*'],
        resources: [stopExportJobLambdaFunctionDLQ.queueArn],
        principals: [new AnyPrincipal()],
        conditions: {
          Bool: {
            'aws:SecureTransport': false,
          },
        },
      }),
    );

    const stopExportJobLambdaFunction = new NodejsFunction(this, 'stopExportJobLambdaFunction', {
      ...defaultBulkExportLambdaProps,
      handler: 'stopExportJobHandler',
      // reservedConcurrentExecutions: isDev ? 10 : 200,
      deadLetterQueue: stopExportJobLambdaFunctionDLQ,
    });

    const getJobStatusLambdaFunctionDLQ = new Queue(this, 'getJobStatusLambdaFunctionDLQ', {
      retentionPeriod: Duration.days(14),
      encryptionMasterKey: Alias.fromAliasName(this, 'getJobStatusLambdaFunctionDLQKey', 'alias/aws/sqs'),
    });
    NagSuppressions.addResourceSuppressions(getJobStatusLambdaFunctionDLQ, [
      {
        id: 'AwsSolutions-SQS3',
        reason: 'This is a DLQ.',
      },
    ]);
    const getJobStatusLambdaFunctionDLQHttpsOnlyPolicy = new QueuePolicy(
      this,
      'getJobStatusLambdaFunctionDLQHttpsOnlyPolicy',
      {
        queues: [getJobStatusLambdaFunctionDLQ],
      },
    );
    getJobStatusLambdaFunctionDLQHttpsOnlyPolicy.document.addStatements(
      new PolicyStatement({
        effect: Effect.DENY,
        actions: ['SQS:*'],
        resources: [getJobStatusLambdaFunctionDLQ.queueArn],
        principals: [new AnyPrincipal()],
        conditions: {
          Bool: {
            'aws:SecureTransport': false,
          },
        },
      }),
    );

    const getJobStatusLambdaFunction = new NodejsFunction(this, 'getJobStatusLambdaFunction', {
      ...defaultBulkExportLambdaProps,
      handler: 'getJobStatusHandler',
      // reservedConcurrentExecutions: isDev ? 10 : 200,
      deadLetterQueue: getJobStatusLambdaFunctionDLQ,
    });

    const updateStatusLambdaFunctionDLQ = new Queue(this, 'updateStatusLambdaFunctionDLQ', {
      retentionPeriod: Duration.days(14),
      encryptionMasterKey: Alias.fromAliasName(this, 'updateStatusLambdaFunctionDLQKey', 'alias/aws/sqs'),
    });
    NagSuppressions.addResourceSuppressions(updateStatusLambdaFunctionDLQ, [
      {
        id: 'AwsSolutions-SQS3',
        reason: 'This is a DLQ.',
      },
    ]);
    const updateStatusLambdaFunctionDLQHttpsOnlyPolicy = new QueuePolicy(
      this,
      'updateStatusLambdaFunctionDLQHttpsOnlyPolicy',
      {
        queues: [updateStatusLambdaFunctionDLQ],
      },
    );
    updateStatusLambdaFunctionDLQHttpsOnlyPolicy.document.addStatements(
      new PolicyStatement({
        effect: Effect.DENY,
        actions: ['SQS:*'],
        resources: [updateStatusLambdaFunctionDLQ.queueArn],
        principals: [new AnyPrincipal()],
        conditions: {
          Bool: {
            'aws:SecureTransport': false,
          },
        },
      }),
    );

    const updateStatusLambdaFunction = new NodejsFunction(this, 'updateStatusLambdaFunction', {
      ...defaultBulkExportLambdaProps,
      handler: 'updateStatusStatusHandler',
      role: bulkExportResources.updateStatusLambdaRole,
      // reservedConcurrentExecutions: isDev ? 10 : 200,
      deadLetterQueue: updateStatusLambdaFunctionDLQ,
    });

    const uploadGlueScriptsLambdaFunctionDLQ = new Queue(this, 'uploadGlueScriptsLambdaFunctionDLQ', {
      retentionPeriod: Duration.days(14),
      encryptionMasterKey: Alias.fromAliasName(this, 'uploadGlueScriptsLambdaFunctionDLQKey', 'alias/aws/sqs'),
    });
    NagSuppressions.addResourceSuppressions(uploadGlueScriptsLambdaFunctionDLQ, [
      {
        id: 'AwsSolutions-SQS3',
        reason: 'This is a DLQ.',
      },
    ]);
    const uploadGlueScriptsLambdaFunctionDLQHttpsOnlyPolicy = new QueuePolicy(
      this,
      'uploadGlueScriptsLambdaFunctionDLQHttpsOnlyPolicy',
      {
        queues: [uploadGlueScriptsLambdaFunctionDLQ],
      },
    );
    uploadGlueScriptsLambdaFunctionDLQHttpsOnlyPolicy.document.addStatements(
      new PolicyStatement({
        effect: Effect.DENY,
        actions: ['SQS:*'],
        resources: [uploadGlueScriptsLambdaFunctionDLQ.queueArn],
        principals: [new AnyPrincipal()],
        conditions: {
          Bool: {
            'aws:SecureTransport': false,
          },
        },
      }),
    );

    const uploadGlueScriptsLambdaFunction = new NodejsFunction(this, 'uploadGlueScriptsLambdaFunction', {
      timeout: Duration.seconds(30),
      memorySize: 192,
      // reservedConcurrentExecutions: isDev ? 10 : 200,
      runtime: Runtime.NODEJS_16_X,
      role: bulkExportResources.uploadGlueScriptsLambdaRole,
      description: 'Upload glue scripts to s3',
      handler: 'handler',
      entry: path.join(__dirname, '../bulkExport/uploadGlueScriptsToS3.ts'),
      deadLetterQueue: uploadGlueScriptsLambdaFunctionDLQ,
      bundling: {
        ...defaultLambdaBundlingOptions,
        commandHooks: {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          beforeBundling(inputDir, outputDir) {
            return [];
          },
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          beforeInstall(inputDir, outputDir) {
            return [];
          },
          afterBundling(inputDir, outputDir) {
            // copy all the necessary files for the lambda into the bundle
            // this allows the lambda functions for bulk export to have access to these files within the lambda instance
            return [
              `node scripts/build_lambda.js ${inputDir} ${outputDir} bulkExport/glueScripts/export-script.py`,
              `node scripts/build_lambda.js ${inputDir} ${outputDir} bulkExport/schema/transitiveReferenceParams.json`,
              `node scripts/build_lambda.js ${inputDir} ${outputDir} bulkExport/schema/${props!.patientCompartmentFileV3}`,
              `node scripts/build_lambda.js ${inputDir} ${outputDir} bulkExport/schema/${props!.patientCompartmentFileV4}`
            ];
          }
        }
      },
      environment: {
        ...lambdaDefaultEnvVars,
        GLUE_SCRIPTS_BUCKET: bulkExportResources.glueScriptsBucket.bucketName
      }
    });

    const updateSearchMappingsLambdaFunctionDLQ = new Queue(this, 'updateSearchMappingsLambdaFunctionDLQ', {
      retentionPeriod: Duration.days(14),
      encryptionMasterKey: Alias.fromAliasName(this, 'updateSearchMappingsLambdaFunctionDLQKey', 'alias/aws/sqs'),
    });
    NagSuppressions.addResourceSuppressions(updateSearchMappingsLambdaFunctionDLQ, [
      {
        id: 'AwsSolutions-SQS3',
        reason: 'This is a DLQ.',
      },
    ]);
    const updateSearchMappingsLambdaFunctionDLQHttpsOnlyPolicy = new QueuePolicy(
      this,
      'updateSearchMappingsLambdaFunctionDLQHttpsOnlyPolicy',
      {
        queues: [updateSearchMappingsLambdaFunctionDLQ],
      },
    );
    updateSearchMappingsLambdaFunctionDLQHttpsOnlyPolicy.document.addStatements(
      new PolicyStatement({
        effect: Effect.DENY,
        actions: ['SQS:*'],
        resources: [updateSearchMappingsLambdaFunctionDLQ.queueArn],
        principals: [new AnyPrincipal()],
        conditions: {
          Bool: {
            'aws:SecureTransport': false,
          },
        },
      }),
    );

    const updateSearchMappingsLambdaFunction = new NodejsFunction(
      this,
      'updateSearchMappingsLambdaFunction',
      {
        timeout: Duration.seconds(300),
        memorySize: 512,
        runtime: Runtime.NODEJS_16_X,
        // reservedConcurrentExecutions: isDev ? 10 : 200,
        description: 'Custom resource Lambda to update the search mappings',
        deadLetterQueue: updateSearchMappingsLambdaFunctionDLQ,
        role: new Role(this, 'updateSearchMappingsLambdaRole', {
          assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
          inlinePolicies: {
            DdbToEsLambdaPolicy: new PolicyDocument({
              statements: [
                new PolicyStatement({
                  effect: Effect.ALLOW,
                  actions: ['logs:CreateLogStream', 'logs:CreateLogGroup', 'logs:PutLogEvents'],
                  resources: [`arn:${this.partition}:logs:${props!.region}:*:*`]
                }),
                new PolicyStatement({
                  effect: Effect.ALLOW,
                  actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
                  resources: [
                    `arn:${this.partition}:logs:${props!.region}:*:*`,
                    `${elasticSearchResources.elasticSearchDomain.domainArn}/*`,
                  ],
                }),
                new PolicyStatement({
                  effect: Effect.ALLOW,
                  actions: ['es:ESHttpPost', 'es:ESHttpPut', 'es:ESHttpHead'],
                  resources: [`${elasticSearchResources.elasticSearchDomain.domainArn}/*`]
                })
              ]
            }),
            KMSPolicy: new PolicyDocument({
              statements: [
                new PolicyStatement({
                  effect: Effect.ALLOW,
                  actions: [
                    'kms:Describe*',
                    'kms:Get*',
                    'kms:List*',
                    'kms:Encrypt',
                    'kms:Decrypt',
                    'kms:ReEncrypt*',
                    'kms:GenerateDataKey',
                    'kms:GenerateDataKeyWithoutPlaintext'
                  ],
                  resources: [kmsResources.elasticSearchKMSKey.keyArn]
                })
              ]
            })
          }
        }),
        handler: 'handler',
        entry: path.join(__dirname, '../src/updateSearchMappings/index.ts'),
        bundling: {
          target: 'es2020'
        },
        environment: {
          ...lambdaDefaultEnvVars,
          ELASTICSEARCH_DOMAIN_ENDPOINT: `https://${elasticSearchResources.elasticSearchDomain.domainEndpoint}`,
          NUMBER_OF_SHARDS: `${isDev ? 1 : 3}` // 133 indices, one per resource type
        }
      }
    );
    // eslint-disable-next-line no-new
    new CustomResource(this, 'updateSearchMappingsCustomResource', {
      serviceToken: updateSearchMappingsLambdaFunction.functionArn,
      properties: {
        RandomValue: Math.random() // to force redeployment
      }
    });

    const bulkExportStateMachine = new BulkExportStateMachine(
      this,
      updateStatusLambdaFunction,
      startExportJobLambdaFunction,
      getJobStatusLambdaFunction,
      stopExportJobLambdaFunction,
      props!.stage,
      kmsResources.logKMSKey,
    );

    // Define Backup Resources here:
    // NOTE: this is an extra Cloudformation stack; not linked to FHIR Server stack
    // This is not deployed by default, but can be added to cdk-infra.ts under /bin/ to do so,
    // pass enableBackup=true when running cdk deploy (e.g. cdk deploy -c enableBackup=true)
    if (props!.enableBackup) {
      // eslint-disable-next-line no-new
      new Backup(this, 'backup', { backupKMSKey: kmsResources.backupKMSKey });
    }

    // eslint-disable-next-line no-new
    new CustomResource(this, 'uploadGlueScriptsCustomResource', {
      serviceToken: uploadGlueScriptsLambdaFunction.functionArn,
      properties: {
        RandomValue: Math.random() // to force redeployment,
      }
    });

    // Define main resources here:
    const apiGatewayAuthorizer = new CognitoUserPoolsAuthorizer(this, 'apiGatewayAuthorizer', {
      authorizerName: `fhir-works-authorizer-${props!.stage}-${props!.region}`,
      identitySource: 'method.request.header.Authorization',
      cognitoUserPools: [userPool],
      resultsCacheTtl: Duration.seconds(300)
    });

    const subscriptionsMatcherDLQ = new Queue(this, 'subscriptionsMatcherDLQ', {
      retentionPeriod: Duration.days(14),
      encryptionMasterKey: Alias.fromAliasName(this, 'kmsMasterKeyId', 'alias/aws/sqs')
    });
    NagSuppressions.addResourceSuppressions(subscriptionsMatcherDLQ, [
      {
        id: 'AwsSolutions-SQS3',
        reason: 'This is a DLQ.'
      }
    ]);

    const subscriptionsMatcherDLQHttpsOnlyPolicy = new QueuePolicy(
      this,
      'subscriptionsMatcherDLQHttpsOnlyPolicy',
      {
        queues: [subscriptionsMatcherDLQ]
      }
    );
    subscriptionsMatcherDLQHttpsOnlyPolicy.document.addStatements(
      new PolicyStatement({
        effect: Effect.DENY,
        actions: ['SQS:*'],
        resources: [subscriptionsMatcherDLQ.queueArn],
        principals: [new AnyPrincipal()],
        conditions: {
          Bool: {
            'aws:SecureTransport': false
          }
        }
      })
    );

    const fhirServerDLQ = new Queue(this, 'fhirServerDLQ', {
      retentionPeriod: Duration.days(14),
      encryptionMasterKey: Alias.fromAliasName(this, 'fhirServerDLQKey', 'alias/aws/sqs'),
    });
    NagSuppressions.addResourceSuppressions(fhirServerDLQ, [
      {
        id: 'AwsSolutions-SQS3',
        reason: 'This is a DLQ.',
      },
    ]);
    const fhirServerDLQHttpsOnlyPolicy = new QueuePolicy(this, 'fhirServerDLQHttpsOnlyPolicy', {
      queues: [fhirServerDLQ],
    });
    fhirServerDLQHttpsOnlyPolicy.document.addStatements(
      new PolicyStatement({
        effect: Effect.DENY,
        actions: ['SQS:*'],
        resources: [fhirServerDLQ.queueArn],
        principals: [new AnyPrincipal()],
        conditions: {
          Bool: {
            'aws:SecureTransport': false,
          },
        },
      }),
    );

    const fhirServerLambda = new NodejsFunction(this, 'fhirServer', {
      timeout: Duration.seconds(40),
      memorySize: 512,
      // reservedConcurrentExecutions: isDev ? 100 : 200,
      description: 'FHIR API Server',
      entry: path.join(__dirname, '../src/index.ts'),
      handler: 'handler',
      deadLetterQueue: fhirServerDLQ,
      currentVersionOptions: {
        provisionedConcurrentExecutions: 5
      },
      bundling: {
        ...defaultLambdaBundlingOptions,
        commandHooks: {
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          beforeBundling(inputDir, outputDir) {
            return [];
          },
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          beforeInstall(inputDir, outputDir) {
            return [];
          },
          afterBundling(inputDir, outputDir) {
            // copy all the necessary files for the lambda into the bundle
            // this allows the validators to be constructed with the compiled implementation guides
            return [
              `node scripts/build_lambda.js ${inputDir}/compiledImplementationGuides ${outputDir}/compiledImplementationGuides none true`
            ];
          }
        }
      },
      runtime: Runtime.NODEJS_16_X,
      environment: {
        ...lambdaDefaultEnvVars,
        EXPORT_STATE_MACHINE_ARN: bulkExportStateMachine.bulkExportStateMachine.stateMachineArn,
        PATIENT_COMPARTMENT_V3: props!.patientCompartmentFileV3,
        PATIENT_COMPARTMENT_V4: props!.patientCompartmentFileV4,
        VALIDATOR_LAMBDA_ALIAS: props!.useHapiValidator ? this.javaHapiValidator!.alias.functionArn : ''
      },
      role: new Role(this, 'fhirServerLambdaRole', {
        assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
        inlinePolicies: {
          FhirServerLambdaPolicy: new PolicyDocument({
            statements: [
              new PolicyStatement({
                effect: Effect.ALLOW,
                actions: ['logs:CreateLogStream', 'logs:CreateLogGroup', 'logs:PutLogEvents'],
                resources: [`arn:${this.partition}:logs:${props!.region}:*:*`]
              }),
              new PolicyStatement({
                effect: Effect.ALLOW,
                actions: [
                  'kms:Describe*',
                  'kms:Get*',
                  'kms:List*',
                  'kms:Encrypt',
                  'kms:Decrypt',
                  'kms:ReEncrypt*',
                  'kms:GenerateDataKey',
                  'kms:GenerateDataKeyWithoutPlaintext'
                ],
                resources: [
                  kmsResources.s3KMSKey.keyArn,
                  kmsResources.dynamoDbKMSKey.keyArn,
                  kmsResources.elasticSearchKMSKey.keyArn,
                  kmsResources.securityLogKMSKey?.keyArn as string,
                ]
              }),
              new PolicyStatement({
                effect: Effect.ALLOW,
                actions: [
                  'dynamodb:Query',
                  'dynamodb:Scan',
                  'dynamodb:GetItem',
                  'dynamodb:PutItem',
                  'dynamodb:UpdateItem',
                  'dynamodb:DeleteItem',
                  'dynamodb:BatchWriteItem',
                  'dynamodb:PartiQLInsert',
                  'dynamodb:PartiQLUpdate'
                ],
                resources: [
                  resourceDynamoDbTable.tableArn,
                  `${resourceDynamoDbTable.tableArn}/index/*`,
                  exportRequestDynamoDbTable.tableArn
                ]
              }),
              new PolicyStatement({
                effect: Effect.ALLOW,
                actions: ['dynamodb:Query'],
                resources: [`${exportRequestDynamoDbTable.tableArn}/index/*`]
              }),
              new PolicyStatement({
                effect: Effect.ALLOW,
                actions: ['es:ESHttpGet', 'es:ESHttpHead', 'es:ESHttpPost'],
                resources: [`${elasticSearchResources.elasticSearchDomain.domainArn}/*`]
              }),
              new PolicyStatement({
                effect: Effect.ALLOW,
                actions: ['s3:*Object', 's3:ListBucket', 's3:DeleteObjectVersion'],
                resources: [fhirBinaryBucket.bucketArn, fhirBinaryBucket.arnForObjects('*')]
              }),
              new PolicyStatement({
                effect: Effect.ALLOW,
                actions: ['s3:ListBucket', 's3:GetObject'],
                resources: [
                  bulkExportResources.bulkExportResultsBucket.bucketArn,
                  `${bulkExportResources.bulkExportResultsBucket.bucketArn}/*`
                ]
              }),
              new PolicyStatement({
                effect: Effect.ALLOW,
                actions: ['xray:PutTraceSegments', 'xray:PutTelemtryRecords'],
                resources: [
                  `arn:${this.partition}:logs:${props!.region}:*:*`,
                  kmsResources.dynamoDbKMSKey.keyArn,
                  resourceDynamoDbTable.tableArn,
                  `${resourceDynamoDbTable.tableArn}/index/*`,
                  exportRequestDynamoDbTable.tableArn,
                  `${exportRequestDynamoDbTable.tableArn}/index/*`,
                  `${elasticSearchResources.elasticSearchDomain.domainArn}/*`,
                  fhirBinaryBucket.bucketArn,
                  fhirBinaryBucket.arnForObjects('*'),
                  bulkExportResources.bulkExportResultsBucket.bucketArn,
                  `${bulkExportResources.bulkExportResultsBucket.bucketArn}/*`,
                  bulkExportResources.exportResultsSignerRole.roleArn,
                  bulkExportStateMachine.bulkExportStateMachine.stateMachineArn,
                ],
              }),
              new PolicyStatement({
                effect: Effect.ALLOW,
                actions: ['sts:AssumeRole'],
                resources: [bulkExportResources.exportResultsSignerRole.roleArn]
              }),
              new PolicyStatement({
                effect: Effect.ALLOW,
                actions: ['states:StartExecution'],
                resources: [bulkExportStateMachine.bulkExportStateMachine.stateMachineArn]
              })
            ]
          })
        }
      }),
      tracing: Tracing.ACTIVE
    });
    if (props!.useHapiValidator) {
      fhirServerLambda.role?.addToPrincipalPolicy(
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['lambda:InvokeFunction'],
          resources: [this.javaHapiValidator!.alias.functionArn]
        })
      );
    }
    fhirServerLambda.addAlias(`fhir-server-lambda-${props!.stage}`);

    const usagePlan = apiGatewayRestApi
      .addUsagePlan('apiUsagePlan', {
        throttle: {
          burstLimit: 100, // maximum API request rate limit over a time ranging from one to a few seconds
          rateLimit: 50 // average requests per second over an extended period of time
        },
        name: `fhir-service-${props!.stage}`,
        apiStages: [
          {
            api: apiGatewayRestApi,
            stage: apiGatewayRestApi.deploymentStage
          }
        ]
      });

    var apiGatewayApiKey: any = "";
    if (props!.useApiKeys) {
      apiGatewayApiKey = apiGatewayRestApi.addApiKey('developerApiKey', {
        description: 'Key for developer access to the FHIR Api',
        apiKeyName: `developer-key-${props!.stage}`
      });
      usagePlan.addApiKey(apiGatewayApiKey)
    }

    // events 0
    const fhirServerResource = apiGatewayRestApi.root.addResource(serverEndpoint);
    fhirServerResource.addMethod('ANY', new LambdaIntegration(fhirServerLambda), {
      authorizer: apiGatewayAuthorizer,
      authorizationType: AuthorizationType.COGNITO,
      apiKeyRequired: props!.useApiKeys,
      authorizationScopes: cognitoScopes,
    });

    // events 1
    const proxyResource = apiGatewayRestApi.root.addResource(proxyEndpoint);
    proxyResource.addMethod('ANY', new LambdaIntegration(fhirServerLambda), {
      authorizer: apiGatewayAuthorizer,
      authorizationType: AuthorizationType.COGNITO,
      apiKeyRequired: props!.useApiKeys,
      authorizationScopes: cognitoScopes
    });
    // events 2
    const metadataResource = apiGatewayRestApi.root.addResource(serverMetadata);
    metadataResource.addMethod('GET', new LambdaIntegration(fhirServerLambda), {
      authorizationType: AuthorizationType.NONE,
      apiKeyRequired: props!.useApiKeys
    });

    if (props!.corsOrigins != '') {
      // events 3
      fhirServerResource.addMethod('OPTIONS', new LambdaIntegration(fhirServerLambda), {
        authorizationType: AuthorizationType.NONE,
        apiKeyRequired: false
      });
      // events 4
      proxyResource.addMethod('OPTIONS', new LambdaIntegration(fhirServerLambda), {
        authorizationType: AuthorizationType.NONE,
        apiKeyRequired: false
      });
      metadataResource.addMethod('OPTIONS', new LambdaIntegration(fhirServerLambda), {
        authorizationType: AuthorizationType.NONE,
        apiKeyRequired: false
      });
    }
    // Serverless:
    //    - If: '"${self:custom.enableMultiTenancy}" == "true" && "${self:custom.useTenantSpecificUrl}" == "true"'
    //      Exclude:
    //         - resources.extensions.ApiGatewayMethodMetadataGet
    if (props!.enableMultiTenancy && props!.useTenantSpecificUrl) {
      NagSuppressions.addResourceSuppressionsByPath(
        this,
        `/fhir-service-${props!.stage}/apiGatewayRestApi/Default/metadata/GET/Resource`,
        [
          {
            id: 'AwsSolutions-APIG4',
            reason: 'The /metadata endpoints do not require Authorization'
          },
          {
            id: 'AwsSolutions-COG4',
            reason: 'The /metadata endpoints do not require an Authorizer'
          }
        ]
      );
    } else {
      NagSuppressions.addResourceSuppressionsByPath(
        this,
        `/fhir-service-${props!.stage}/apiGatewayRestApi/Default/tenant/{tenantId}/metadata/GET/Resource`,
        [
          {
            id: 'AwsSolutions-APIG4',
            reason: 'The /metadata endpoints do not require Authorization'
          },
          {
            id: 'AwsSolutions-COG4',
            reason: 'The /metadata endpoints do not require an Authorizer'
          }
        ]
      );
    }

    const ddbToEsDLQ = new Queue(this, 'ddbToEsDLQ', {
      retentionPeriod: Duration.days(14),
      encryptionMasterKey: Alias.fromAliasName(this, 'ddbToEsDLQMasterKeyId', 'alias/aws/sqs')
    });

    NagSuppressions.addResourceSuppressions(ddbToEsDLQ, [
      {
        id: 'AwsSolutions-SQS3',
        reason: 'This is a DLQ.',
      },
    ]);

    const ddbToEsLambda = new NodejsFunction(this, 'ddbToEs', {
      timeout: Duration.seconds(300),
      runtime: Runtime.NODEJS_16_X,
      // reservedConcurrentExecutions: isDev ? 10 : 200,
      description: 'Write DDB changes from `resource` table to ElasticSearch service',
      handler: 'handler',
      entry: path.join(__dirname, '../src/ddbToEsLambda/index.ts'),
      bundling: {
        target: 'es2020'
      },
      environment: {
        ENABLE_ES_HARD_DELETE: `${props!.enableESHardDelete}`,
        ...lambdaDefaultEnvVars
      },
      deadLetterQueue: ddbToEsDLQ,
      role: new Role(this, 'DdbToEsLambdaRole', {
        assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
        inlinePolicies: {
          DdbToEsLambdaPolicy: new PolicyDocument({
            statements: [
              new PolicyStatement({
                effect: Effect.ALLOW,
                actions: ['logs:CreateLogStream', 'logs:CreateLogGroup', 'logs:PutLogEvents'],
                resources: [`arn:${this.partition}:logs:${props!.region}:*:*`]
              }),
              new PolicyStatement({
                effect: Effect.ALLOW,
                actions: [
                  'dynamodb:GetShardIterator',
                  'dynamodb:DescribeStream',
                  'dynamodb:ListStreams',
                  'dynamodb:GetRecords'
                ],
                resources: [resourceDynamoDbTable.tableStreamArn!]
              }),
              new PolicyStatement({
                effect: Effect.ALLOW,
                actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
                resources: [
                  `arn:${this.partition}:logs:${props!.region}:*:*`,
                  resourceDynamoDbTable.tableStreamArn!,
                  `${elasticSearchResources.elasticSearchDomain.domainArn}/*`,
                  ddbToEsDLQ.queueArn,
                ],
              }),
              new PolicyStatement({
                effect: Effect.ALLOW,
                actions: ['es:ESHttp*'],
                resources: [`${elasticSearchResources.elasticSearchDomain.domainArn}/*`]
              }),
              new PolicyStatement({
                effect: Effect.ALLOW,
                actions: ['sqs:SendMessage'],
                resources: [ddbToEsDLQ.queueArn]
              })
            ]
          }),
          KMSPolicy: new PolicyDocument({
            statements: [
              new PolicyStatement({
                effect: Effect.ALLOW,
                actions: [
                  'kms:Describe*',
                  'kms:Get*',
                  'kms:List*',
                  'kms:Encrypt',
                  'kms:Decrypt',
                  'kms:ReEncrypt*',
                  'kms:GenerateDataKey',
                  'kms:GenerateDataKeyWithoutPlaintext'
                ],
                resources: [kmsResources.dynamoDbKMSKey.keyArn, kmsResources.elasticSearchKMSKey.keyArn]
              })
            ]
          })
        }
      })
    });
    ddbToEsLambda.addEventSource(
      new DynamoEventSource(resourceDynamoDbTable, {
        batchSize: 15,
        retryAttempts: 3,
        startingPosition: StartingPosition.LATEST
      })
    );

    const subscriptionReaperDLQ = new Queue(this, 'subscriptionReaperDLQ', {
      retentionPeriod: Duration.days(14),
      encryptionMasterKey: Alias.fromAliasName(this, 'subscriptionReaperDLQKey', 'alias/aws/sqs'),
    });
    const subscriptionReaperDLQHttpsOnlyPolicy = new QueuePolicy(this, 'subscriptionReaperDLQHttpsOnlyPolicy', {
      queues: [subscriptionReaperDLQ],
    });
    subscriptionReaperDLQHttpsOnlyPolicy.document.addStatements(
      new PolicyStatement({
        effect: Effect.DENY,
        actions: ['SQS:*'],
        resources: [subscriptionReaperDLQ.queueArn],
        principals: [new AnyPrincipal()],
        conditions: {
          Bool: {
            'aws:SecureTransport': false,
          },
        },
      }),
    );
    NagSuppressions.addResourceSuppressions(subscriptionReaperDLQ, [
      {
        id: 'AwsSolutions-SQS3',
        reason: 'This is a DLQ.',
      },
    ]);

    const subscriptionReaper = new NodejsFunction(this, 'subscriptionReaper', {
      timeout: Duration.seconds(30),
      runtime: Runtime.NODEJS_16_X,
      // reservedConcurrentExecutions: isDev ? 10 : 200,
      description: 'Scheduled Lambda to remove expired Subscriptions',
      deadLetterQueue: subscriptionReaperDLQ,
      role: new Role(this, 'subscriptionReaperRole', {
        assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
        inlinePolicies: {
          SubscriptionReaperPolicy: new PolicyDocument({
            statements: [
              new PolicyStatement({
                effect: Effect.ALLOW,
                actions: ['dynamodb:UpdateItem', 'dynamodb:Query'],
                resources: [`${resourceDynamoDbTable.tableArn}/index/*`, resourceDynamoDbTable.tableArn]
              }),
              new PolicyStatement({
                effect: Effect.ALLOW,
                actions: ['logs:CreateLogStream', 'logs:CreateLogGroup', 'logs:PutLogEvents'],
                resources: [`arn:${this.partition}:logs:${props!.region}:*:*`]
              })
            ]
          }),
          KMSPolicy: new PolicyDocument({
            statements: [
              new PolicyStatement({
                effect: Effect.ALLOW,
                actions: [
                  'kms:Describe*',
                  'kms:Get*',
                  'kms:List*',
                  'kms:Encrypt',
                  'kms:Decrypt',
                  'kms:ReEncrypt*',
                  'kms:GenerateDataKey',
                  'kms:GenerateDataKeyWithoutPlaintext'
                ],
                resources: [kmsResources.dynamoDbKMSKey.keyArn]
              })
            ]
          })
        }
      }),
      handler: 'handler',
      entry: path.join(__dirname, '../src/subscriptions/reaperLambda/index.ts'),
      bundling: {
        target: 'es2020'
      },
      environment: {
        ...lambdaDefaultEnvVars
      }
    });
    new Rule(this, 'subscriptionReaperScheduleEvent', {
      schedule: Schedule.rate(Duration.minutes(5)),
      enabled: props!.enableSubscriptions
    }).addTarget(new LambdaFunction(subscriptionReaper));

    const ddbToEsDLQHttpsOnlyPolicy = new QueuePolicy(this, 'ddbToEsDLQHttpsOnlyPolicy', {
      queues: [ddbToEsDLQ]
    });
    ddbToEsDLQHttpsOnlyPolicy.document.addStatements(
      new PolicyStatement({
        effect: Effect.DENY,
        actions: ['SQS:*'],
        resources: [ddbToEsDLQ.queueArn],
        principals: [new StarPrincipal()],
        conditions: {
          Bool: {
            'aws:SecureTransport': 'false'
          }
        }
      })
    );
    NagSuppressions.addResourceSuppressions(ddbToEsDLQ, [
      {
        id: 'AwsSolutions-SQS3',
        reason: 'This is a DLQ.'
      }
    ]);

    const subscriptionsMatcher = new NodejsFunction(this, 'subscriptionsMatcher', {
      timeout: Duration.seconds(20),
      memorySize: isDev ? 512 : 1024,
      // reservedConcurrentExecutions: isDev ? 10 : 200,
      runtime: Runtime.NODEJS_16_X,
      description: 'Match ddb events against active Subscriptions and emit notifications',
      deadLetterQueue: subscriptionsMatcherDLQ,
      role: new Role(this, 'subscriptionsMatcherLambdaRole', {
        assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
        inlinePolicies: {
          SubscriptionsMatcherLambdaPolicy: new PolicyDocument({
            statements: [
              new PolicyStatement({
                effect: Effect.ALLOW,
                actions: ['logs:CreateLogStream', 'logs:CreateLogGroup', 'logs:PutLogEvents'],
                resources: [`arn:${this.partition}:logs:${props!.region}:*:*`]
              }),
              new PolicyStatement({
                effect: Effect.ALLOW,
                actions: [
                  'dynamodb:GetShardIterator',
                  'dynamodb:DescribeStream',
                  'dynamodb:ListStreams',
                  'dynamodb:GetRecords'
                ],
                resources: [resourceDynamoDbTable.tableStreamArn!]
              }),
              new PolicyStatement({
                effect: Effect.ALLOW,
                actions: ['dynamodb:Query', 'dynamodb:Scan', 'dynamodb:GetItem'],
                resources: [resourceDynamoDbTable.tableArn]
              }),
              new PolicyStatement({
                effect: Effect.ALLOW,
                actions: ['dynamodb:Query'],
                resources: [`${resourceDynamoDbTable.tableArn}/index/*`]
              }),
              new PolicyStatement({
                effect: Effect.ALLOW,
                actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
                resources: [
                  `arn:${this.partition}:logs:${props!.region}:*:*`,
                  resourceDynamoDbTable.tableStreamArn!,
                  resourceDynamoDbTable.tableArn,
                  `${resourceDynamoDbTable.tableArn}/index/*`,
                  subscriptionsMatcherDLQ.queueArn,
                ],
              }),
              new PolicyStatement({
                effect: Effect.ALLOW,
                actions: ['sqs:SendMessage'],
                resources: [subscriptionsMatcherDLQ.queueArn]
              })
            ]
          }),
          KMSPolicy: new PolicyDocument({
            statements: [
              new PolicyStatement({
                effect: Effect.ALLOW,
                actions: [
                  'kms:Describe*',
                  'kms:Get*',
                  'kms:List*',
                  'kms:Encrypt',
                  'kms:Decrypt',
                  'kms:ReEncrypt*',
                  'kms:GenerateDataKey',
                  'kms:GenerateDataKeyWithoutPlaintext'
                ],
                resources: [kmsResources.dynamoDbKMSKey.keyArn]
              })
            ]
          }),
          PublishToSNSPolicy: new PolicyDocument({
            statements: [
              new PolicyStatement({
                effect: Effect.ALLOW,
                actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
                resources: [subscriptionsResources.subscriptionsKey.keyArn]
              }),
              new PolicyStatement({
                effect: Effect.ALLOW,
                actions: ['sns:Publish'],
                resources: [subscriptionsResources.subscriptionsTopic.ref]
              })
            ]
          })
        }
      }),
      handler: 'handler',
      entry: path.join(__dirname, '../src/subscriptions/matcherLambda/index.ts'),
      bundling: {
        target: 'es2020'
      },
      environment: {
        SUBSCRIPTIONS_TOPIC: subscriptionsResources.subscriptionsTopic.ref,
        ...lambdaDefaultEnvVars
      }
    });
    if (props!.enableSubscriptions) {
      subscriptionsMatcher.addEventSource(
        new DynamoEventSource(resourceDynamoDbTable, {
          batchSize: 15,
          retryAttempts: 3,
          startingPosition: StartingPosition.LATEST
        })
      );
    }

    const subscriptionsRestHookDLQ = new Queue(this, 'subscriptionsRestHookDLQ', {
      retentionPeriod: Duration.days(14),
      encryptionMasterKey: Alias.fromAliasName(this, 'subscriptionsRestHookDLQKey', 'alias/aws/sqs'),
    });
    NagSuppressions.addResourceSuppressions(subscriptionsRestHookDLQ, [
      {
        id: 'AwsSolutions-SQS3',
        reason: 'This is a DLQ.',
      },
    ]);
    const subscriptionsRestHookDLQHttpsOnlyPolicy = new QueuePolicy(
      this,
      'subscriptionsRestHookDLQHttpsOnlyPolicy',
      {
        queues: [subscriptionsRestHookDLQ],
      },
    );
    subscriptionsRestHookDLQHttpsOnlyPolicy.document.addStatements(
      new PolicyStatement({
        effect: Effect.DENY,
        actions: ['SQS:*'],
        resources: [subscriptionsRestHookDLQ.queueArn],
        principals: [new AnyPrincipal()],
        conditions: {
          Bool: {
            'aws:SecureTransport': false,
          },
        },
      }),
    );

    // eslint-disable-next-line no-new
    new NodejsFunction(this, 'subscriptionsRestHook', {
      timeout: Duration.seconds(10),
      runtime: Runtime.NODEJS_16_X,
      // reservedConcurrentExecutions: isDev ? 10 : 200,
      description: 'Send rest-hook notification for subscription',
      role: subscriptionsResources.restHookLambdaRole,
      handler: 'handler',
      entry: path.join(__dirname, '../src/subscriptions/restHookLambda/index.ts'),
      deadLetterQueue: subscriptionsRestHookDLQ,
      bundling: {
        target: 'es2020'
      },
      environment: {
        ...lambdaDefaultEnvVars
      },
      events: [
        new SqsEventSource(subscriptionsResources.restHookQueue, {
          batchSize: 50,
          maxBatchingWindow: Duration.seconds(10),
          reportBatchItemFailures: true
        })
      ]
    });

    // Create alarms resources here:
    // eslint-disable-next-line no-new
    new AlarmsResource(
      this,
      props!.stage,
      ddbToEsLambda,
      kmsResources.snsKMSKey,
      ddbToEsDLQ,
      fhirServerLambda,
      apiGatewayRestApi,
      this.stackName,
      this.account,
      elasticSearchResources.elasticSearchDomain,
      isDev
    );
    // create outputs for stack here:
    // eslint-disable-next-line no-new
    new CfnOutput(this, 'userPoolId', {
      description: 'User pool id for the provisioning users',
      value: `${userPool.userPoolId}`,
      exportName: `UserPoolId-${props!.stage}`
    });
    // eslint-disable-next-line no-new
    new CfnOutput(this, 'userPoolAppClientId', {
      description: 'App client id for the provisioning users.',
      value: `${props!.extUserPoolClientId}`,
      exportName: `UserPoolAppClientId-${props!.stage}`
    });
    // eslint-disable-next-line no-new
    new CfnOutput(this, 'FHIRBinaryBucket', {
      description: 'S3 bucket for storing Binary objects',
      value: `${fhirBinaryBucket.bucketArn}`,
      exportName: `FHIRBinaryBucket-${props!.stage}`
    });
    // eslint-disable-next-line no-new
    new CfnOutput(this, 'resourceDynamoDbTableArnOutput', {
      description: 'DynamoDB table for storing non-Binary resources',
      value: `${resourceDynamoDbTable.tableArn}`,
      exportName: `ResourceDynamoDbTableArn-${props!.stage}`
    });
    // eslint-disable-next-line no-new
    new CfnOutput(this, 'resourceDynamoDbTableStreamArnOutput', {
      description: 'DynamoDB stream for the DDB table storing non-Binary resources',
      value: `${resourceDynamoDbTable.tableStreamArn}`,
      exportName: `ResourceDynamoDbTableStreamArn-${props!.stage}`
    });
    // eslint-disable-next-line no-new
    new CfnOutput(this, 'exportRequestDynamoDbTableArnOutput', {
      description: 'DynamoDB table for storing bulk export requests',
      value: `${resourceDynamoDbTable.tableArn}`,
      exportName: `ExportRequestDynamoDbTableArnOutput-${props!.stage}`
    });
    // eslint-disable-next-line no-new
    new CfnOutput(this, 'elasticsearchDomainEndpointOutput', {
      description: 'Endpoint of ElasticSearch instance',
      value: `${elasticSearchResources.elasticSearchDomain.domainEndpoint}`,
      exportName: `ElasticSearchDomainEndpoint-${props!.stage}`
    });
    // eslint-disable-next-line no-new
    new CfnOutput(this, 'developerApiKeyOutput', {
      description: 'Key for developer access to the API',
      value: `${apiGatewayApiKey}`,
      exportName: `DeveloperAPIKey-${props!.stage}`
    });

    if (isDev) {
      // eslint-disable-next-line no-new
      new CfnOutput(this, 'elasticsearchDomainKibanaEndpointOutput', {
        description: 'ElasticSearch Kibana endpoint',
        value: `${elasticSearchResources.elasticSearchDomain.domainEndpoint}/_plugin/kibana`,
        exportName: `ElasticSearchDomainKibanaEndpoint-${props!.stage}`,
        condition: isDevCondition
      });
      // eslint-disable-next-line no-new
      new CfnOutput(this, 'elasticsearchKibanaUserPoolIdOutput', {
        description: 'User pool id for the provisioning ES Kibana users.',
        value: `${elasticSearchResources.kibanaUserPool!.ref}`,
        exportName: `ElasticSearchKibanaUserPoolId-${props!.stage}`,
        condition: isDevCondition
      });
      // eslint-disable-next-line no-new
      new CfnOutput(this, 'elasticsearchKibanaUserPoolAppClientIdOutput', {
        description: 'App client id for the provisioning ES Kibana users.',
        value: `${elasticSearchResources.kibanaUserPoolClient!.ref}`,
        exportName: `ElasticSearchKibanaUserPoolAppClientId-${props!.stage}`,
        condition: isDevCondition
      });
    }
  }
}
