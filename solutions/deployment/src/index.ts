/*
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *  SPDX-License-Identifier: Apache-2.0
 */

import { generateServerlessRouter } from '@aws/fhir-works-on-aws-routing';
import { CorsOptions } from 'cors';
import serverless from 'serverless-http';
import { getFhirConfig, genericResources, getCorsOrigins } from './config';

const corsOrigins = getCorsOrigins();

const corsOptions: CorsOptions | undefined = corsOrigins
  ? {
    origin: corsOrigins, // '*',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'HEAD', 'DELETE'],
    allowedHeaders: ['Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'],
    preflightContinue: false,
  }
  : undefined;

const ensureAsyncInit = async (initPromise: Promise<any>): Promise<void> => {
  try {
    await initPromise;
  } catch (e) {
    console.error('Async initialization failed', e);
    // Explicitly exit the process so that next invocation re-runs the init code.
    // This prevents Lambda containers from caching a rejected init promise
    process.exit(1);
  }
};

async function asyncServerless() {
  return serverless(generateServerlessRouter(await getFhirConfig(), genericResources, corsOptions), {
    request(request: any, event: any) {
      request.user = event.user;
    },
  });
}

const serverlessHandler: Promise<any> = asyncServerless();

export const handler = async (event: any = {}, context: any = {}): Promise<any> => {
  await ensureAsyncInit(serverlessHandler);
  return (await serverlessHandler)(event, context);
};

export default ensureAsyncInit;
