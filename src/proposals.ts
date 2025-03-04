import type { Context } from '@netlify/functions';
import crypto from 'crypto';

import { ApolloClient, InMemoryCache, gql } from '@apollo/client/core/core.cjs';

// Setup Apollo Client
const apiKey = Netlify.env.get('APOLLO_API_KEY') || '';
const apolloClient = new ApolloClient({
  uri: 'https://api.apollographql.com/api/graphql',
  cache: new InMemoryCache(),
});

enum ProposalStatus {
  OPEN = 'OPEN',
  DRAFT = 'DRAFT',
  IMPLEMENTED = 'IMPLEMENTED',
  APPROVED = 'APPROVED',
}

interface ProposalNotificationEvent {
  "eventType": string;
  "eventId": string;
  "graphId": string;
  "variantId": string;
  "proposalId": string;
  "change": {
    "status": ProposalStatus | undefined
    "previousStatus": ProposalStatus | undefined
    "revisionId": string | undefined
  },
  "timestamp": string;
}

const schemaHashesQuery = gql`
  query SchemaHashes($graphId: ID!, $name: String!) {
    graph(id: $graphId) {
      variant(name: $name) {
        proposal {
          latestRevision {
            launch {
              build {
                result {
                  ... on BuildSuccess {
                    coreSchema {
                      coreHash
                    }
                  }
                }
              }
            }
          }
          sourceVariant {
            latestLaunch {
              build {
                result {
                  ... on BuildSuccess {
                    coreSchema {
                      coreHash
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

const schemaDiffQuery = gql`
  query FlatDiff($graphId: ID!, $oldSchemaHash: SHA256!, $newSchemaHash: SHA256!) {
    graph(id: $graphId) {
      flatDiff( oldSdlHash: $oldSchemaHash, newSdlHash: $newSchemaHash) {
        ... on FlatDiff {
          diff {
            ... on FlatDiffItemValue {
              value
            }
          }
        }
      }
    }
  }
`;

const setReviewerMutation = gql`
  mutation UpdateRequestedReviewers ($input: UpdateRequestedReviewersInput!, $id: ID!, $name: String!) {
    graph(id: $id) {
      variant(name: $name) {
        proposal {
          ... on ProposalMutation {
            updateRequestedReviewers(input: $input) {
              __typename
              ... on Proposal {
                id
              }
              ... on ValidationError {
                message
              }
              ... on PermissionError {
                message
              }
            }
          }
        }
      }
    }
  }
`;


async function delay(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
async function getSchemaHashes(variantId: string, graphId: string) {

  let oldSchemaHash: string = '';
  let newSchemaHash: string = '';

  try {
    const response = await apolloClient.query({
      query: schemaHashesQuery,
      variables: {
        graphId,
        name: variantId,
      },
      fetchPolicy: 'no-cache',
      context: {
        headers: {
          'Content-Type': 'application/json',
          'apollographql-client-name': 'proposals-reviewer-automation',
          'apollographql-client-version': '0.0.1',
          'x-api-key': apiKey

        }
      }
    });

    const ProposalRevisionLaunch = response.data.graph.variant.proposal.latestRevision.launch.build.result;

    if (ProposalRevisionLaunch == null) {
      console.log('ProposalRevisionLaunch is null, retrying...');
      await delay(2000);
      return getSchemaHashes(variantId, graphId);
    }

    oldSchemaHash = response.data.graph.variant.proposal.sourceVariant.latestLaunch.build.result.coreSchema.coreHash;
    newSchemaHash = response.data.graph.variant.proposal.latestRevision.launch.build.result.coreSchema.coreHash;

    if (oldSchemaHash == undefined || newSchemaHash == undefined) {
      console.error(`Error getting schema hashes: oldSchemaHash:, ${oldSchemaHash}, newSchemaHash: ${newSchemaHash}`);
    }

  } catch (e) {
    console.error('Error getting schema hashes:', e);
  }

  return [ oldSchemaHash, newSchemaHash ];

}

async function getImpactedOwners(schemaHashes: string[], graphId: string) {
  let email: string = '';
  try {
    const response = await apolloClient.query({
      query: schemaDiffQuery,
      variables: {
        graphId,
        oldSchemaHash: schemaHashes[0],
        newSchemaHash: schemaHashes[1],
      },
      fetchPolicy: 'no-cache',
      context: {
        headers: {
          'Content-Type': 'application/json',
          'apollographql-client-name': 'proposals-reviewer-automation',
          'apollographql-client-version': '0.0.1',
          'x-api-key': apiKey
        }
      }
    });

    const diff = response.data.graph.flatDiff.diff;


    const ownerDirectiveRegex = /@owner\(team: \["([^"]+)"\]\)/;

    for (const item of diff) {
      console.log('Item:', item);
      const match = ownerDirectiveRegex.exec(item.value);
      if (match) {
        email = match[1];
        break;
      }
    }

    console.log('Owner email:', email);
  } catch (e) {
    console.error('Error getting schema diff:', e);
  }

  return email;
}

async function setReviewer(variantId: string, graphId: string, ownerEmail: string) {

  function capitalizeWords(email: string): string {
    const [localPart, domainPart] = email.split('@');
    const capitalizedLocalPart = localPart.replace(/\b\w/g, (char) => char.toUpperCase());
    const capitalizedDomainPart = domainPart.toLowerCase().replace('libertymutual.com', 'LibertyMutual.com');
    return `${capitalizedLocalPart}@${capitalizedDomainPart}`;
  }

  const apolloUserPrefix = 'po.liberty-mutual.';
  const apolloUserId = `${apolloUserPrefix}${capitalizeWords(ownerEmail)}`;
  console.log('Apollo User Email:', apolloUserId);

  try {
    const response = await apolloClient.mutate({
      mutation: setReviewerMutation,
      variables: {
        id: graphId,
        name: variantId,
        input: {
          reviewerUserIdsToAdd: [apolloUserId],
        }
      },
      fetchPolicy: 'no-cache',
      context: {
        headers: {
          'Content-Type': 'application/json',
          'apollographql-client-name': 'proposals-reviewer-automation',
          'apollographql-client-version': '0.0.1',
          'x-api-key': apiKey,
        },
      },
    });

    console.log('Apollo Studio API Response:', response.data.graph.variant.proposal);
  } catch (error) {
    console.error('Error setting reviewer:', error);
  }
}

const isAuthorized = async (req: Request, payload: string) => {
  const providedSignature = req.headers.get('x-apollo-signature');

  const hmacSecret = Netlify.env.get('APOLLO_HMAC_TOKEN') || '';
  const hmac = crypto.createHmac('sha256', hmacSecret);
  hmac.update(payload);
  const calculatedSignature = `sha256=${hmac.digest('hex')}`;

  return providedSignature === calculatedSignature;
};


export default async function applyReviewers(req: Request, context: Context): Promise<void> {

  const payload = (await req.text()) || '{}';
  const shouldProceed = await isAuthorized(req, payload);

  if (!shouldProceed) {
    console.error('Unauthorized request');
    return;
  }

  const proposalNotificationEvent = JSON.parse(payload) as ProposalNotificationEvent;

  const schemaHashes = await getSchemaHashes(proposalNotificationEvent.variantId, proposalNotificationEvent.graphId);

  const ownerEmail = await getImpactedOwners(schemaHashes, proposalNotificationEvent.graphId);

  await setReviewer(proposalNotificationEvent.variantId, proposalNotificationEvent.graphId, ownerEmail);
}


