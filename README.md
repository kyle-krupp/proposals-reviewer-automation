# custom-check-examples
Repository with a sample applications for implementing a GraphOS Schema Check webhook integration

**The code in this repository is experimental and has been provided for reference purposes only. Community feedback is welcome but this project may not be supported in the same way that repositories in the official [Apollo GraphQL GitHub organization](https://github.com/apollographql) are. If you need help you can file an issue on this repository, [contact Apollo](https://www.apollographql.com/contact-sales) to talk to an expert, or create a ticket directly in Apollo Studio.**

TK Link to Custom Check Documentation

## Netlify Function

This implementation is to deploy a [netlify function](https://www.netlify.com/platform/core/functions/) that can be used to set up an integration with GraphOS Schema Checks. After building and deploying the function, configure your schema checks in Apollo Studio to tell GraphOS to notify your endpoint during each schema check.

This sample implementation will receive the webhook payload (*TK link to docs*) from GraphOS, validate the HMAC value in the `x-apollo-signature` header, download the composed supergraph, and lint the schema using graphql-eslint. Finally it will upload any violations found by the linter back to GraphOS to complete the custom check task.

### Instructions

1. Set up a netlify account, then install and authenticate with [netlify CLI](https://docs.netlify.com/cli/get-started/)
2. Install dependencies and build function code. `$ npm install ; npm run build`
3. Deploy to netlify, follow CLI instructions for creating and configuring a new site. `$ netlify deploy`
4. Publish using the root directory. The `netlify.toml` file has a pointer to the `dist/` to upload the built function.
5. Pull up the function in the Netlify web console. Navigate to "Site configuration > Environment variables"
6. Upload values for the environment variables `APOLLO_HMAC_TOKEN` and `APOLLO_API_KEY`. The HMAC token should be any String that will be used to calculate the x-apollo-signature header. The API key should have sufficient permissions to run schema checks for the Graph you are integrating this application with.
7. Deploy function to production. `$ netlify deploy --prod`
8. Copy the fuction url plus the path `/custom-lint` and go to Apollo Studio.
9. Navigate to the custom check configuration for your graph and add a webhook integration for the function url and secret token.
10. Test the integration in Studio and verify the logs in the netlify console. Then using [rover](https://www.apollographql.com/docs/rover/) submit a schema check and verify the logs in netlify console as well as the checks page in Studio.
