import {
  Authorization,
  KeyValueMap,
  RequestContext,
  Search,
  SearchResult
} from '@aws/fhir-works-on-aws-interface';
import { hash } from '../router/handlers/utils';
/**
 * Helper encapsulates the typeSearch request
 */
export default class ResourceTypeSearch {
  private authService: Authorization;

  private searchService: Search;

  constructor(authService: Authorization, searchService: Search) {
    this.authService = authService;
    this.searchService = searchService;
  }

  async searchResources(
    resourceType: string,
    queryParams: any,
    userIdentity: KeyValueMap,
    requestContext: RequestContext,
    serverUrl: string,
    tenantId?: string
  ): Promise<SearchResult> {
    const allowedResourceTypes = await this.authService.getAllowedResourceTypesForOperation({
      operation: 'search-type',
      userIdentity,
      requestContext
    });

    const searchFilters = await this.authService.getSearchFilterBasedOnIdentity({
      userIdentity,
      requestContext,
      operation: 'search-type',
      resourceType,
      fhirServiceBaseUrl: serverUrl
    });

    const searchResponse = await this.searchService.typeSearch({
      resourceType,
      queryParams,
      baseUrl: serverUrl,
      allowedResourceTypes,
      searchFilters,
      tenantId,
      sessionId: hash(userIdentity)
    });

    return searchResponse.result;
  }
}
