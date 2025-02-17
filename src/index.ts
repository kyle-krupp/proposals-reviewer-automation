import applyReviewers from './proposals';
import type { Config } from '@netlify/functions';

export default applyReviewers;

export const config: Config = {
  path: '/apply-reviewers',
};
