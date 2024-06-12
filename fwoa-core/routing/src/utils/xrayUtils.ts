import { Express } from 'express';

const isLambdaEnv = (process.env.AWS_EXECUTION_ENV || '').startsWith('AWS_Lambda_');
let AWSXRay: any;

export const initXRayExpress = () => {
    if (isLambdaEnv) {
        AWSXRay = require('aws-xray-sdk');
        // noinspection JSCheckFunctionSignatures
        AWSXRay.captureHTTPsGlobal(require('http'));
        // noinspection JSCheckFunctionSignatures
        AWSXRay.captureHTTPsGlobal(require('https'));
        return AWSXRay.express;
    }
    return undefined;
};

export const openXRaySegment = (app: Express, XRayExpress: any, name: string): any => {
    if (XRayExpress) {
        app.use(XRayExpress.openSegment(name));
    }
};

export const closeXRaySegment = (app: Express, XRayExpress: any): void => {
    if (XRayExpress) {
        app.use(XRayExpress.closeSegment());
    }
};

export const openNewXRaySubSegment = (name: string): any => {
    if (isLambdaEnv) {
        return AWSXRay.getSegment().addNewSubsegment(name);
    }
    return undefined;
};

export const closeXRaySubSegment = (segment: any): void => {
    if (segment) {
        segment.close();
    }
};
