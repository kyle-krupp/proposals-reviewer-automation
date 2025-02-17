import type { Context } from '@netlify/functions';
import crypto from 'crypto';

import { ApolloClient, InMemoryCache, gql } from '@apollo/client/core/core.cjs';

// Setup Apollo Client
const apolloClient = new ApolloClient({
  uri: 'https://api.apollographql.com/api/graphql',
  cache: new InMemoryCache(),
});


const setReviewerMutation = gql`
  mutation UpdateRequestedReviewers($input: UpdateRequestedReviewersInput!, $name: String!, $graphId: ID!) {
  graph(id: $graphId) {
    variant(name: $name) {
      proposal {
        ... on ProposalMutation {
          updateRequestedReviewers(input: $input) {
            ... on Proposal {
              createdAt
            }
          }
        }
      }
    }
  }
}
`;


async function setReviewer(proposalId: string) {
  const apiKey = Netlify.env.get('APOLLO_API_KEY') || '';

  const graphId = Netlify.env.get('APOLLO_GRAPH_ID') || '';

  try {
    const response = await apolloClient.mutate({
      mutation: setReviewerMutation,
      variables: {
        input: {
          reviewerIds: ['123'],
        },
        proposalId: proposalId,
        graphId,
        name: 'kyle.krupp@libertymutual.com',
      },
      context: {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
      },
    });

    console.log(response.data);
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
  const payload = (await req.json()) || '{}';

  const shouldProceed = await isAuthorized(req, payload);

  if (shouldProceed) {
    const event = JSON.parse(payload)
    console.log(event);
  }
}
