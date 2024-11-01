import customLint from './eslint';
//import pullRequestCheck from './github';
import type { Config } from '@netlify/functions';

export default customLint;
//export default pullRequestCheck;

export const config: Config = {
  path: '/custom-check',
};
