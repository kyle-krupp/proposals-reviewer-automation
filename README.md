# Custom schema check webhook examples

This repository contains a sample validation service for GraphOS [custom schema check](https://www.apollographql.com/docs/graphos/delivery/custom-checks).

> [!NOTE]  
> The code in this repository is experimental and has been provided for reference purposes only. This repository may not be supported in the same way that repositories in the official [Apollo GraphQL GitHub organization](https://github.com/apollographql) are. If you need help, you can file an issue on this repository, [contact Apollo Support](https://support.apollographql.com/), or create a ticket directly in [GraphOS Studio](https://studio.apollographql.com/).

## Example graphql-eslint implementation

This example implementation deploys a [Netlify function](https://www.netlify.com/platform/core/functions/) that can be used to set up a webhook integration with GraphOS [schema checks](https://www.apollographql.com/docs/graphos/delivery/schema-checks).

This example Netlify function does the following:

- Receives the [webhook payload](http://localhost:3000/graphos/delivery/custom-checks#webhook-format) from GraphOS.
- Validates the HMAC value in the `x-apollo-signature` header.
- Downloads the composed supergraph.
- Lints the schema using [graphql-eslint](https://github.com/dimaMachina/graphql-eslint#readme).
- Uploads any linter violations back to GraphOS to complete the custom check task.

After building and deploying the function, you need to [enable custom schema checks and register the function endpoint in GraphOS Studio](https://www.apollographql.com/docs/graphos/delivery/custom-checks#enable-custom-checks-in-studio).

## Installation

1. Set up a Netlify account, then install and authenticate with [Netlify CLI](https://docs.netlify.com/cli/get-started/).
1. Install dependencies and build function code. `$ npm install ; npm run build`
1. To deploy to Netlify, follow the CLI instructions for creating and configuring a new site. `$ netlify deploy`
   - When asked for the publish directory, use the default root directory. The `netlify.toml` file has a pointer to the `dist/` to upload the built function.
1. Pull up site you created in the [Netlify web console](https://app.netlify.com/).
1. In the Netlify console, go to **Site configuration > Environment variables**. Add and upload values for the environment variables: `APOLLO_HMAC_TOKEN` and `APOLLO_API_KEY`.
   - The `APOLLO_HMAC_TOKEN` should be any string that will be used to calculate the `x-apollo-signature header`.
   - The `APOLLO_API_KEY` is a [GraphOS API key](https://www.apollographql.com/docs/graphos/api-keys/) with sufficient permissions to run schema checks for the graph you're integrating this application with.
1. Deploy the function to production. `$ netlify deploy --prod`
1. From your terminal, copy the **Website URL** plus the path `/custom-lint` and go to [GraphOS Studio](https://studio.apollographql.com/).
1. In the graph you're integrating this with go to **Checks > Configuration** and enable custom checks, registering the function URL and entering your `APOLLO_HMAC_TOKEN` as the secret token.
1. Run a schema check using the [Rover CLI](https://www.apollographql.com/docs/rover/) to test the integration.
   - You should see check results in GraphOS Studio on the **Checks** page. You can also verify logs in the Netlify console.
