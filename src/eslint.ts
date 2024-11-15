import crypto from 'crypto';
import {
  print,
  isSpecifiedScalarType,
  isSpecifiedDirective,
  parse,
  StringValueNode,
} from 'graphql';
import { ApolloClient, InMemoryCache, gql } from '@apollo/client/core/core.cjs';
import * as graphql from '@graphql-eslint/eslint-plugin';
import type { Config, Context } from '@netlify/functions';
import { ESLint, Linter } from 'eslint';

const linter = new Linter({ cwd: '.' });

function getSourceLocationCoordinate(
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
    console.log('changed subgraphs', changedSubgraphs);
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
    console.log(supergraphSource);

    const violationResults = changedSubgraphs.map((subgraph) => {
      const code = docsResult.data.graph?.docs?.find(
        (doc) => doc?.hash === subgraph.hash,
      )?.source;
      if (typeof code !== 'string') {
        return null;
      }

      const violations = [];

      const parsedSchema = parse(code);
      console.log('parsedSchema', parsedSchema);
      const schemaDefinition = parsedSchema.definitions.find(
        (doc) => doc.kind === 'SchemaDefinition' || doc.kind === 'SchemaExtension',
      );
      console.log('schemaDefinition', schemaDefinition);
      const contactSchemaDirective = schemaDefinition?.directives?.find(
        (directive) => directive.name.value === 'contact',
      );

      if (!contactSchemaDirective) {
        return {
          level: 'WARNING' as const,
          message: 'Subgraphs must contain a contact directive',
          rule: 'Must contain a properly formatted @contact directive for each subgraph',
          // sourceLocations: [
          //   {
          //     subgraphName: subgraph.name,
          //     start: startSourceLocationCoordiante,
          //     end:
          //       typeof violation.endLine === 'number' &&
          //       typeof violation.endColumn === 'number'
          //         ? getSourceLocationCoordinate(
          //             code,
          //             violation.endLine,
          //             violation.endColumn,
          //           )
          //         : startSourceLocationCoordiante,
          //   },
          // ],
        };
      }

      const contactSchemaFields = contactSchemaDirective?.arguments?.map(
        (argu) => ({
          field: argu.name.value,
          value: (argu.value as StringValueNode).value,
        }),
      );

      const allFieldsHaveValues = contactSchemaFields?.every(
        ({ field, value }) => Boolean(field) && Boolean(value),
      );
      const contactSchemaFieldNames = contactSchemaFields?.map(
        (field) => field.field,
      );
      const hasAllRequiredFields = ['name', 'url', 'description'].every(
        (fieldName) => contactSchemaFieldNames?.includes(fieldName),
      );

      if (!hasAllRequiredFields)
        violations.push({
          level: 'WARNING' as const,
          message: 'Contact directive must have a name, url, and description',
          rule: 'Must contain a properly formatted @contact directive for each subgraph',
          // sourceLocations: [
          //   {
          //     subgraphName: subgraph.name,
          //     start: startSourceLocationCoordiante,
          //     end:
          //       typeof violation.endLine === 'number' &&
          //       typeof violation.endColumn === 'number'
          //         ? getSourceLocationCoordinate(
          //             code,
          //             violation.endLine,
          //             violation.endColumn,
          //           )
          //         : startSourceLocationCoordiante,
          //   },
          // ],
        });

      if (!allFieldsHaveValues)
        violations.push({
          level: 'WARNING' as const,
          message: 'Contact directive values are not all present',
          rule: 'Must contain a properly formatted @contact directive for each subgraph',
          // sourceLocations: [
          //   {
          //     subgraphName: subgraph.name,
          //     start: startSourceLocationCoordiante,
          //     end:
          //       typeof violation.endLine === 'number' &&
          //       typeof violation.endColumn === 'number'
          //         ? getSourceLocationCoordinate(
          //             code,
          //             violation.endLine,
          //             violation.endColumn,
          //           )
          //         : startSourceLocationCoordiante,
          //   },
          // ],
        });

        return violations;
    });

    console.log(
      'variables',
      JSON.stringify({
        graphId: event.checkStep.graphId,
        name: event.checkStep.graphVariant,
        input: {
          taskId: event.checkStep.taskId,
          workflowId: event.checkStep.workflowId,
          status: 'SUCCESS',
          violations: violationResults,
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
          status: 'SUCCESS',
          violations: violationResults,
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
    console.log('signature invalid');
    return new Response('Signature is invalid', { status: 403 });
  }
}
