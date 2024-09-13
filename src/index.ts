import { ApolloClient, gql, InMemoryCache } from "@apollo/client/core/core.cjs";
import * as graphql from '@graphql-eslint/eslint-plugin';
import crypto from 'crypto';
import { Linter } from 'eslint';
import type { Config, Context } from "@netlify/functions";

const linter = new Linter({cwd: '.',});

const apolloClient = new ApolloClient({
    uri: Netlify.env.get('APOLLO_STUDIO_URL') ?? 'https://api.apollographql.com/api/graphql',
    cache: new InMemoryCache(),
});

const docQuery = gql`query Doc($graphId: ID!, $hash: SHA256) {
  graph(id: $graphId) {
    doc(hash: $hash) {
      source
    }
  }
}`;

const customCheckCallbackMutation = gql`mutation CustomCheckCallback($input: CustomCheckCallbackInput!, $name: String!, $graphId: ID!) {
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
}`;

export default async (req: Request, context: Context) => {
  const hmacSecret = Netlify.env.get('APOLLO_HMAC_TOKEN') || '';
  const apiKey = Netlify.env.get('APOLLO_API_KEY') || '';

  const payload = await req.text() || '{}';
  console.log(`Payload: ${payload}`);
  const providedSignature = req.headers.get('x-apollo-signature');

  const hmac = crypto.createHmac('sha256', hmacSecret);
  hmac.update(payload);
  const calculatedSignature = `sha256=${hmac.digest('hex')}`;

  if (providedSignature === calculatedSignature) {
    const event = JSON.parse(payload);
    console.log(`Handling taskId: ${event.checkStep.taskId}`);
    const docResult = await apolloClient.query({
      query: docQuery,
      variables: {
        graphId: event.checkStep.graphId,
        // supergraph hash
        hash: event.proposedSchema.hash,
      },
      context: {
        headers: {
          "Content-Type": "application/json",
          "apollographql-client-name": "custom-checks-example",
          "apollographql-client-version": "0.0.1",
          "x-api-key": apiKey
        }
      }
    });
    const code = docResult.data.graph.doc.source

    // @ts-ignore
    const messages = linter.verify(code, {
      files: ['*.graphql'],
      plugins: {
        '@graphql-eslint': { rules: graphql.rules },
      },
      languageOptions: {
        parser: graphql,
        parserOptions: {
          graphQLConfig: { schema: code },
        },
      },
      rules: graphql.flatConfigs['schema-recommended'].rules,
    }, 'schema.graphql');

    console.log(`eslint messages: ${JSON.stringify(messages)}`);

    const violations = messages.map(violation => ({
      // Fail check if a naming convention is violated
      level: violation.ruleId === '@graphql-eslint/naming-convention' ? 'ERROR' : 'WARNING',
      message: violation.message,
      rule: violation.ruleId ?? 'unknown',
      sourceLocations: {
        start: {
          byteOffset: 0,
          line: violation.line,
          column: violation.column,
        },
        end: {
          byteOffset: 0,
          line: violation.endLine,
          column: violation.endColumn,
        }
      }
    }));

    const callbackResult = await apolloClient.mutate({
      mutation: customCheckCallbackMutation,
        variables: {
          graphId: event.checkStep.graphId,
          name: event.checkStep.graphVariant,
          input: {
            taskId: event.checkStep.taskId,
            workflowId: event.checkStep.workflowId,
            status: violations.find(violation => violation.level === 'ERROR') !== undefined ? 'FAILURE' : 'SUCCESS',
            violations: violations,
          }
        },
        context: {
          headers: {
            "Content-Type": "application/json",
            "apollographql-client-name": "custom-checks-example",
            "apollographql-client-version": "0.0.1",
            "x-api-key": apiKey
          }
        }
      });
    console.log(JSON.stringify(`Callback results: ${JSON.stringify(callbackResult)}`));
    return new Response('OK', { status: 200 });
  } else {
    return new Response('Signature is invalid', { status: 403 });
  }
};

export const config: Config = {
  path: '/custom-lint'
};
