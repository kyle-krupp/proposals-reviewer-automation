import crypto from 'crypto';

import { ApolloClient, InMemoryCache, gql } from '@apollo/client/core/core.cjs';
import * as graphql from '@graphql-eslint/eslint-plugin';
import type { Config, Context } from '@netlify/functions';
import { ESLint, Linter } from 'eslint';

const linter = new Linter({ cwd: '.' });

function getSourceLocationCoordiante(
  code: string,
  line: number,
  column: number,
) {
  const lines = code.split('\n').slice(0, line);
  const lastLine = lines[lines.length - 1];
  return {
    line,
    column,
    byteOffset:
      [...lines.slice(0, -1), lastLine.slice(0, column)].join('\n').length - 1,
  };
}

const apolloClient = new ApolloClient({
  uri:
    Netlify.env.get('APOLLO_STUDIO_URL') ??
    'https://api.apollographql.com/api/graphql',
  cache: new InMemoryCache(),
});

const docsQuery = gql`
  query CustomChecksExampleDocs($graphId: ID!, $hashes: [SHA256!]!) {
    graph(id: $graphId) {
      docs(hashes: $hashes) {
        hash
        source
      }
    }
  }
`;

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

interface Payload {
  baseSchema: {
    hash: string;
    subgraphs?: Array<{ hash: string; name: string }> | null;
  };
  proposedSchema: {
    hash: string;
    subgraphs?: Array<{ hash: string; name: string }> | null;
  };
  checkStep: {
    taskId: string;
    graphId: string;
    graphVariant: string;
    workflowId: string;
  };
  gitContext: {
    branch?: string | null;
    commit?: string | null;
    committer?: string | null;
    message?: string | null;
    remoteUrl?: string | null;
  };
}

export default async function customLint(req: Request, context: Context) {
  const hmacSecret = Netlify.env.get('APOLLO_HMAC_TOKEN') || '';
  const apiKey = Netlify.env.get('APOLLO_API_KEY') || '';

  const payload = (await req.text()) || '{}';
  console.log(`Payload: ${payload}`);
  const providedSignature = req.headers.get('x-apollo-signature');

  const hmac = crypto.createHmac('sha256', hmacSecret);
  hmac.update(payload);
  const calculatedSignature = `sha256=${hmac.digest('hex')}`;

  if (providedSignature === calculatedSignature) {
    const event = JSON.parse(payload) as Payload;
    console.log(`Handling taskId: ${event.checkStep.taskId}`);
    const changedSubgraphs = (event.proposedSchema.subgraphs ?? []).filter(
      (proposedSubgraph) =>
        event.baseSchema.subgraphs?.find(
          (baseSubgraph) => baseSubgraph.name === proposedSubgraph.name,
        )?.hash !== proposedSubgraph.hash,
    );
    const hashesToCheck = [
      event.proposedSchema.hash,
      ...changedSubgraphs.map((s) => s.hash),
    ];
    console.log(`fetching: ${hashesToCheck}`);
    const docsResult = await apolloClient
      .query<{
        graph: null | {
          docs: null | Array<null | { hash: string; source: string }>;
        };
      }>({
        query: docsQuery,
        variables: {
          graphId: event.checkStep.graphId,
          hashes: hashesToCheck,
        },
        context: {
          headers: {
            'Content-Type': 'application/json',
            'apollographql-client-name': 'custom-checks-example',
            'apollographql-client-version': '0.0.1',
            'x-api-key': apiKey,
          },
        },
      })
      .catch((err) => {
        console.error(err);
        return { data: { graph: null } };
      });
    const supergraphSource = docsResult.data.graph?.docs?.find(
      (doc) => doc?.hash === event.proposedSchema.hash,
    )?.source;
    const violations = (
      await Promise.all(
        changedSubgraphs.map(async (subgraph) => {
          const code = docsResult.data.graph?.docs?.find(
            (doc) => doc?.hash === subgraph.hash,
          )?.source;
          if (typeof code !== 'string') {
            return null;
          }
          const eslingConfig: Linter.Config = {
            files: ['*.graphql'],
            plugins: {
              '@graphql-eslint': graphql as unknown as ESLint.Plugin,
            },
            rules: graphql.flatConfigs['schema-recommended']
              .rules as unknown as Linter.RulesRecord,
            languageOptions: {
              parser: graphql,
              parserOptions: {
                graphQLConfig: { schema: supergraphSource },
              },
            },
          };
          try {
            const messages = linter.verify(
              code,
              eslingConfig,
              'schema.graphql',
            );
            console.log(`eslint messages: ${JSON.stringify(messages)}`);
            return messages.map((violation) => {
              const startSourceLocationCoordiante = getSourceLocationCoordiante(
                code,
                violation.line,
                violation.column,
              );
              return {
                level:
                  violation.severity === 2
                    ? ('ERROR' as const)
                    : ('WARNING' as const),
                message: violation.message,
                rule: violation.ruleId ?? 'unknown',
                sourceLocations: [
                  {
                    subgraphName: subgraph.name,
                    start: startSourceLocationCoordiante,
                    end:
                      typeof violation.endLine === 'number' &&
                      typeof violation.endColumn === 'number'
                        ? getSourceLocationCoordiante(
                            code,
                            violation.endLine,
                            violation.endColumn,
                          )
                        : startSourceLocationCoordiante,
                  },
                ],
              };
            });
          } catch (err) {
            console.log(`Error: ${err}`);
            return null;
          }
        }),
      )
    ).flat();

    console.log(
      'variables',
      JSON.stringify({
        graphId: event.checkStep.graphId,
        name: event.checkStep.graphVariant,
        input: {
          taskId: event.checkStep.taskId,
          workflowId: event.checkStep.workflowId,
          status: violations.some(
            (violation) => violation === null || violation.level === 'ERROR',
          )
            ? 'FAILURE'
            : 'SUCCESS',
          violations: violations.filter((v): v is NonNullable<typeof v> => !!v),
        },
      }),
    );
    const callbackResult = await apolloClient.mutate({
      mutation: customCheckCallbackMutation,
      errorPolicy: 'all',
      variables: {
        graphId: event.checkStep.graphId,
        name: event.checkStep.graphVariant,
        input: {
          taskId: event.checkStep.taskId,
          workflowId: event.checkStep.workflowId,
          status: violations.some(
            (violation) => violation === null || violation.level === 'ERROR',
          )
            ? 'FAILURE'
            : 'SUCCESS',
          violations: violations.filter((v): v is NonNullable<typeof v> => !!v),
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
