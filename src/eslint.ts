import crypto from 'crypto';
import { ConstDirectiveNode, parse, StringValueNode } from 'graphql';
import { ApolloClient, InMemoryCache, gql } from '@apollo/client/core/core.cjs';
import type { Context } from '@netlify/functions';

// Get coordinate info to display line error
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

const getSourceLocationInformation = (
  subgraph: Record<string, string>,
  code: string,
  contactSchemaDirective: ConstDirectiveNode,
) => {
  const startLocationCoordinate = getSourceLocationCoordinate(
    code,
    contactSchemaDirective?.loc?.startToken.line as number,
    contactSchemaDirective?.loc?.startToken.column as number,
  );

  const endLocationCoordinate = getSourceLocationCoordinate(
    code,
    contactSchemaDirective?.loc?.endToken.line as number,
    contactSchemaDirective?.loc?.endToken.column as number,
  );

  return {
    subgraphName: subgraph.name,
    start: startLocationCoordinate,
    end: endLocationCoordinate || startLocationCoordinate,
  };
};

// Setup Apollo Client
const apolloClient = new ApolloClient({
  uri:
    Netlify.env.get('APOLLO_STUDIO_URL') ??
    'https://api.apollographql.com/api/graphql',
  cache: new InMemoryCache(),
});

const docsQuery = gql`
  query SourceCode($graphId: ID!, $hashes: [SHA256!]!) {
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

// Determine if headers match
const isAuthorized = async (req: Request, payload: string) => {
  const providedSignature = req.headers.get('x-apollo-signature');

  const hmacSecret = Netlify.env.get('APOLLO_HMAC_TOKEN') || '';
  const hmac = crypto.createHmac('sha256', hmacSecret);
  hmac.update(payload);
  const calculatedSignature = `sha256=${hmac.digest('hex')}`;

  return providedSignature === calculatedSignature;
};

export default async function customLint(req: Request, context: Context) {
  const apiKey = Netlify.env.get('APOLLO_API_KEY') || '';
  const payload = (await req.text()) || '{}';
  const shouldProceed = await isAuthorized(req, payload);

  // Checks for authorized request
  if (shouldProceed) {
    const event = JSON.parse(payload) as Payload;

    // Determine changed subgraphs
    const changedSubgraphs = (event.proposedSchema.subgraphs ?? []).filter(
      (proposedSubgraph) =>
        event.baseSchema.subgraphs?.find(
          (baseSubgraph) => baseSubgraph.name === proposedSubgraph.name,
        )?.hash !== proposedSubgraph.hash,
    );

    // Get schemas for proposal and changed subgraphs
    const docsResult = await apolloClient
      .query<{
        graph: null | {
          docs: null | Array<null | { hash: string; source: string }>;
        };
      }>({
        query: docsQuery,
        variables: {
          graphId: event.checkStep.graphId,
          hashes: [
            event.proposedSchema.hash,
            ...changedSubgraphs.map((s) => s.hash),
          ],
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

    // Determine if any contactDirectiveSchema violations exist
    const violationResults = changedSubgraphs
      .map((subgraph) => {
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
          (doc) =>
            doc.kind === 'SchemaDefinition' || doc.kind === 'SchemaExtension',
        );
        const contactSchemaDirective = schemaDefinition?.directives?.find(
          (directive) => directive.name.value === 'contact',
        );

        if (!contactSchemaDirective) {
          return {
            level: 'ERROR' as const,
            message: 'Subgraphs must contain a contact directive',
            rule: 'Must contain a properly formatted @contact directive for each subgraph',
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

        const { subgraphName, start, end } = getSourceLocationInformation(
          subgraph,
          code,
          contactSchemaDirective,
        );

        if (!hasAllRequiredFields)
          violations.push({
            level: 'ERROR' as const,
            message: 'Contact directive must have a name, url, and description',
            rule: 'Must contain a properly formatted @contact directive for each subgraph',
            sourceLocations: [{ subgraphName, start, end }],
          });

        if (!allFieldsHaveValues) {
          violations.push({
            level: 'ERROR' as const,
            message: 'Contact directive values are not all present',
            rule: 'Must contain a properly formatted @contact directive for each subgraph',
            sourceLocations: [{ subgraphName, start, end }],
          });
        }

        return violations;
      })
      .flat();

    // Send the result to Apollo Studio
    await apolloClient.mutate({
      mutation: customCheckCallbackMutation,
      errorPolicy: 'all',
      variables: {
        graphId: event.checkStep.graphId,
        name: event.checkStep.graphVariant,
        input: {
          taskId: event.checkStep.taskId,
          workflowId: event.checkStep.workflowId,
          status: violationResults.some(
            (violation) => violation === null || violation.level === 'ERROR',
          )
            ? 'FAILURE'
            : 'SUCCESS',
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
    return new Response('OK', { status: 200 });
  } else {
    return new Response('Signature is invalid', { status: 403 });
  }
}
