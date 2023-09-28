/*
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *  SPDX-License-Identifier: Apache-2.0
 */

import {
  Search,
  History,
  Persistence,
  Authorization,
  KeyValueMap,
  Validator,
  RequestContext
} from '@aws/fhir-works-on-aws-interface';
import BundleGenerator from '../bundle/bundleGenerator';
import CrudHandlerInterface from './CrudHandlerInterface';
import OperationsGenerator from '../operationsGenerator';
import { validateResource } from '../validation/validationUtilities';
import ResourceTypeSearch from '../../utils/ResourceTypeSearch';
import { openNewXRaySubSegment, closeXRaySubSegment } from '../../utils/xrayUtils';

export default class ResourceHandler implements CrudHandlerInterface {
  private validators: Validator[];

  private dataService: Persistence;

  private searchService: ResourceTypeSearch;

  private historyService: History;

  private authService: Authorization;

  constructor(
    dataService: Persistence,
    searchService: Search,
    historyService: History,
    authService: Authorization,
    serverUrl: string,
    validators: Validator[]
  ) {
    this.validators = validators;
    this.dataService = dataService;
    this.searchService = new ResourceTypeSearch(authService, searchService);
    this.historyService = historyService;
    this.authService = authService;
  }

  async create(resourceType: string, resource: any, tenantId?: string) {
    const handlerSubSegment = openNewXRaySubSegment(`create`);
    await validateResource(this.validators, resource, { tenantId, typeOperation: 'create' });

    const createResponse = await this.dataService.createResource({ resourceType, resource, tenantId });
    closeXRaySubSegment(handlerSubSegment);
    return createResponse.resource;
  }

  async update(resourceType: string, id: string, resource: any, tenantId?: string) {
    const handlerSubSegment = openNewXRaySubSegment(`update`);
    await validateResource(this.validators, resource, { tenantId, typeOperation: 'update' });

    const updateResponse = await this.dataService.updateResource({ resourceType, id, resource, tenantId });
    closeXRaySubSegment(handlerSubSegment);
    return updateResponse.resource;
  }

  async patch(resourceType: string, id: string, resource: any, tenantId?: string) {
    const handlerSubSegment = openNewXRaySubSegment(`patch`);
    // TODO Add request validation around patching
    const patchResponse = await this.dataService.patchResource({ resourceType, id, resource, tenantId });
    closeXRaySubSegment(handlerSubSegment);
    return patchResponse.resource;
  }

  async typeSearch(
    resourceType: string,
    queryParams: any,
    userIdentity: KeyValueMap,
    requestContext: RequestContext,
    serverUrl: string,
    tenantId?: string
  ) {
    const handlerSubSegment = openNewXRaySubSegment(`typeSearch`);
    const searchResponse = await this.searchService.searchResources(
      resourceType,
      queryParams,
      userIdentity,
      requestContext,
      serverUrl,
      tenantId
    );
    const bundle = BundleGenerator.generateBundle(
      serverUrl,
      queryParams,
      searchResponse,
      'searchset',
      resourceType
    );

    const filter = this.authService.authorizeAndFilterReadResponse({
      operation: 'search-type',
      userIdentity,
      requestContext,
      readResponse: bundle,
      fhirServiceBaseUrl: serverUrl
    });

    closeXRaySubSegment(handlerSubSegment);
    return filter;
  }

  async typeHistory(
    resourceType: string,
    queryParams: any,
    userIdentity: KeyValueMap,
    requestContext: RequestContext,
    serverUrl: string,
    tenantId?: string
  ) {
    const handlerSubSegment = openNewXRaySubSegment(`typeHistory`);
    const searchFilters = await this.authService.getSearchFilterBasedOnIdentity({
      userIdentity,
      requestContext,
      operation: 'history-type',
      resourceType,
      fhirServiceBaseUrl: serverUrl
    });

    const historyResponse = await this.historyService.typeHistory({
      resourceType,
      queryParams,
      baseUrl: serverUrl,
      searchFilters,
      tenantId
    });
    const bundle = BundleGenerator.generateBundle(
      serverUrl,
      queryParams,
      historyResponse.result,
      'history',
      resourceType
    );
    closeXRaySubSegment(handlerSubSegment);
    return bundle;
  }

  async instanceHistory(
    resourceType: string,
    id: string,
    queryParams: any,
    userIdentity: KeyValueMap,
    requestContext: RequestContext,
    serverUrl: string,
    tenantId?: string
  ) {
    const handlerSubSegment = openNewXRaySubSegment(`instanceHistory`);
    const searchFilters = await this.authService.getSearchFilterBasedOnIdentity({
      userIdentity,
      requestContext,
      operation: 'history-instance',
      resourceType,
      id,
      fhirServiceBaseUrl: serverUrl
    });

    const historyResponse = await this.historyService.instanceHistory({
      id,
      resourceType,
      queryParams,
      baseUrl: serverUrl,
      searchFilters,
      tenantId
    });
    const bundle = BundleGenerator.generateBundle(
      serverUrl,
      queryParams,
      historyResponse.result,
      'history',
      resourceType,
      id
    );
    closeXRaySubSegment(handlerSubSegment);
    return bundle;
  }

  async read(resourceType: string, id: string, tenantId?: string) {
    const handlerSubSegment = openNewXRaySubSegment(`read`);
    const getResponse = await this.dataService.readResource({ resourceType, id, tenantId });
    closeXRaySubSegment(handlerSubSegment);
    return getResponse.resource;
  }

  async vRead(resourceType: string, id: string, vid: string, tenantId?: string) {
    const handlerSubSegment = openNewXRaySubSegment(`vRead`);
    const getResponse = await this.dataService.vReadResource({ resourceType, id, vid, tenantId });
    closeXRaySubSegment(handlerSubSegment);
    return getResponse.resource;
  }

  async delete(resourceType: string, id: string, tenantId?: string) {
    const handlerSubSegment = openNewXRaySubSegment(`delete`);
    await this.dataService.deleteResource({ resourceType, id, tenantId });
    closeXRaySubSegment(handlerSubSegment);
    return OperationsGenerator.generateSuccessfulDeleteOperation();
  }
}
