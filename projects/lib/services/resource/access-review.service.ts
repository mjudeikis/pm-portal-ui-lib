import { GatewayService } from './gateway.service';
import { ResourceNodeContext } from './resource-node-context';
import { ResourceService } from './resource.service';
import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { LuigiCoreService } from '@openmfp/portal-ui-lib';
import {
  Resource,
  ResourceListResult,
  ResourceStatus,
  kcpRootOrgsPath,
} from '@platform-mesh/portal-ui-lib/models';
import { Observable, throwError } from 'rxjs';
import { map } from 'rxjs/operators';

/** The GraphQL gateway endpoint the access virtual workspace is registered as. */
export const defaultAccessReviewGatewayCluster = 'single-access';

// The gateway does not create an object without a name; a review has none of
// its own and is not stored.
export const accessReviewMutation = `mutation {
  access_platform_mesh_io {
    v1alpha1 {
      createSelfClusterAccessReview(object: { metadata: { name: "review" } }) {
        status {
          clusters {
            clusterName
            endpoint
            account { name path displayName type ready }
          }
        }
      }
    }
  }
}`;

/** The account a cluster of a review is the workspace of. */
export interface AccessReviewAccount {
  name: string;
  path?: string;
  displayName?: string;
  type?: string;
  ready?: boolean;
}

export interface AccessReviewCluster {
  clusterName: string;
  endpoint: string;
  account?: AccessReviewAccount;
}

export interface SelfClusterAccessReview {
  status?: { clusters?: AccessReviewCluster[] };
}

export interface AccessReviewGraphQLResponse {
  data?: {
    access_platform_mesh_io?: {
      v1alpha1?: {
        createSelfClusterAccessReview?: SelfClusterAccessReview | null;
      };
    };
  } | null;
  errors?: { message: string }[];
}

/**
 * Asks the access virtual workspace of kcp, through the GraphQL gateway,
 * which accounts the user can access. Unlike a list of the Account resources, which a user either may
 * read completely or not at all, the answer only has the accounts the user
 * has access to.
 */
@Injectable({ providedIn: 'root' })
export class AccessReviewService {
  private httpClient = inject(HttpClient);
  private luigiCoreService = inject(LuigiCoreService);
  private gatewayService = inject(GatewayService);
  private resourceService = inject(ResourceService);

  /**
   * The accounts directly below the workspace of the node context, shaped
   * like a list of Account resources. Errors, also when the review cannot
   * be asked at all, so that a caller can fall back to another source.
   */
  listAccounts(
    nodeContext: ResourceNodeContext,
  ): Observable<ResourceListResult> {
    const kcpPath = this.gatewayService.resolveKcpPath(nodeContext);
    const url = this.reviewUrl(nodeContext);
    const token = this.luigiCoreService.getAuthData()?.idToken;
    if (!url || !kcpPath || !token) {
      return throwError(
        () => new Error('The access review cannot be addressed'),
      );
    }

    return this.httpClient
      .post<AccessReviewGraphQLResponse>(
        url,
        // The workspace the review is addressed to.
        { query: accessReviewMutation, extensions: { clusterTarget: kcpPath } },
        { headers: { Authorization: `Bearer ${token}` } },
      )
      .pipe(
        map((response) => {
          if (response?.errors?.length) {
            throw new Error(response.errors[0].message);
          }
          const review =
            response?.data?.access_platform_mesh_io?.v1alpha1
              ?.createSelfClusterAccessReview;
          if (!review) {
            throw new Error('Not an access review');
          }

          const items = (review.status?.clusters ?? [])
            .map((cluster) => cluster.account)
            .filter(
              (account): account is AccessReviewAccount =>
                !!account && account.path === `${kcpPath}:${account.name}`,
            )
            .map((account) => this.toResource(account, nodeContext))
            .sort((a, b) => a.metadata.name.localeCompare(b.metadata.name));

          // No resource version: there is nothing to watch from.
          return { items, resourceVersion: '', continue: undefined };
        }),
      );
  }

  /**
   * The gateway serves the virtual workspace next to the workspaces, as an
   * endpoint of its own: .../<workspace>/graphql becomes .../single-access/graphql.
   */
  private reviewUrl(nodeContext: ResourceNodeContext): string | undefined {
    const gatewayUrl = nodeContext.portalContext?.crdGatewayApiUrl;
    const workspace = gatewayUrl?.match(
      new RegExp(`(${kcpRootOrgsPath}[^/]*)`),
    )?.[1];
    if (!gatewayUrl || !workspace) {
      return undefined;
    }

    const option = nodeContext.resourceDefinition?.ui?.listView?.accessReview;
    const cluster =
      (typeof option === 'object' && option?.gatewayCluster) ||
      defaultAccessReviewGatewayCluster;

    return gatewayUrl.replace(workspace, cluster);
  }

  private toResource(
    account: AccessReviewAccount,
    nodeContext: ResourceNodeContext,
  ): Resource {
    const ready = !!account.ready;
    const resource: Resource = {
      metadata: { name: account.name },
      spec: { type: account.type ?? '', displayName: account.displayName },
      // What a ready condition of the list reads.
      status: {
        conditions: [
          { type: 'Ready', status: ready ? 'True' : 'False' },
        ] as ResourceStatus['conditions'],
      },
      ready,
    };

    return {
      ...resource,
      id: account.name,
      isAvailable: this.resourceService.isAvailable(
        resource,
        nodeContext.resourceDefinition?.availableWhenNotReady,
      ),
      accessibleName: this.resourceService.getAccessibleName(resource),
    } as Resource;
  }
}
