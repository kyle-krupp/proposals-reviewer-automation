import type { Config } from '@netlify/functions';
import applyReviewers from './proposals';

export default applyReviewers;

export const config: Config = {
  path: '/apply-reviewers',
};
