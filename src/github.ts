import { ApolloClient, gql, InMemoryCache } from '@apollo/client/core/core.cjs';
import crypto from 'crypto';
import type { Context } from '@netlify/functions';

const graphOSClient = new ApolloClient({
  uri:
    Netlify.env.get('APOLLO_STUDIO_URL') ??
    'https://api.apollographql.com/api/graphql',
  cache: new InMemoryCache(),
});

const customCheckCallbackMutation = gql`
  mutation CustomCheckCallback(
    $input: CustomCheckCallbackInput!
    $name: String!
    $graphId: ID!
  ) {
    graph(id: $graphId) {
      variant(name: $name) {
        customCheckCallback(input: $input) {
          __typename
          ... on CustomCheckResult {
            violations {
              level
              message
              rule
            }
          }
          ... on PermissionError {
            message
          }
          ... on TaskError {
            message
          }
          ... on ValidationError {
            message
          }
        }
      }
    }
  }
`;

const githubClient = new ApolloClient({
  uri: 'https://api.github.com/graphql',
  cache: new InMemoryCache(),
});

const pullRequestQuery = gql`
  query prsForBranch($owner: String!, $name: String!, $branch: String!) {
    repository(owner: $owner, name: $name) {
      pullRequests(headRefName: $branch, first: 100) {
        totalCount
        nodes {
          author {
            login
          }
          state
          title
        }
      }
    }
  }
`;

export default async function pullRequestCheck(req: Request, context: Context) {
  const hmacSecret = Netlify.env.get('APOLLO_HMAC_TOKEN') || '';
  const apiKey = Netlify.env.get('APOLLO_API_KEY') || '';

  const payload = (await req.text()) || '{}';
  console.log(`Payload: ${payload}`);
  const providedSignature = req.headers.get('x-apollo-signature');

  const hmac = crypto.createHmac('sha256', hmacSecret);
  hmac.update(payload);
  const calculatedSignature = `sha256=${hmac.digest('hex')}`;

  if (providedSignature === calculatedSignature) {
    const event = JSON.parse(payload);

    const prResult = await githubClient.query({
      query: pullRequestQuery,
      variables: {
        owner: Netlify.env.get('GITHUB_OWNER'),
        name: Netlify.env.get('GITHUB_REPO'),
        branch: event.checkStep.gitContext.branch,
      },
      context: {
        headers: {
          Authorization: `Bearer ${Netlify.env.get('GITHUB_TOKEN')}`,
        },
      },
    });

    console.log(JSON.stringify(`Github results: ${JSON.stringify(prResult)}`));

    const callbackResult = await graphOSClient.mutate({
      mutation: customCheckCallbackMutation,
      variables: {
        graphId: event.checkStep.graphId,
        name: event.checkStep.graphVariant,
        input: {
          taskId: event.checkStep.taskId,
          workflowId: event.checkStep.workflowId,
          status:
            prResult.data.repository.pullRequests.totalCount > 0
              ? 'SUCCESS'
              : 'FAILURE',
          violations: [],
        },
      },
      context: {
        headers: {
          'Content-Type': 'application/json',
          'apollographql-client-name': 'custom-checks-example',
          'apollographql-client-version': '0.0.1',
          'x-api-key': apiKey,
        },
      },
    });
    console.log(
      JSON.stringify(`Callback results: ${JSON.stringify(callbackResult)}`),
    );
    return new Response('OK', { status: 200 });
  } else {
    return new Response('Signature is invalid', { status: 403 });
  }
}
