import { captureException, flush, getCurrentHub, Handlers } from '@sentry/node';
import { Transaction } from '@sentry/types';
import { addExceptionMechanism, logger } from '@sentry/utils';
import { NextApiHandler, NextApiResponse } from 'next';

const { parseRequest } = Handlers;

// purely for clarity
type WrappedNextApiHandler = NextApiHandler;

type AugmentedResponse = NextApiResponse & { __sentryTransaction?: Transaction };

export const withSentry = (handler: NextApiHandler): WrappedNextApiHandler => {
  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
  return async (req, res) => {
    logger.log(`withSentry handler called...`);
    res.end = wrapEndMethod(res.end);

    // con este codigo, funcionan los errores que pasan dentro del `withSentry` (el api error 3 y 4)
    // los que pasan fuera, no se capturan (el 1 y el 2)
    try {
      return await handler(req, res); // Call Handler
    } catch (e) {
      logger.log('Error catched in the handler: ', e.message);
      const currentScope = getCurrentHub().getScope();
      if (currentScope) {
        currentScope.addEventProcessor(event => {
          addExceptionMechanism(event, {
            handled: false,
          });
          return parseRequest(event, req);
        });
        captureException(e);
      }
      throw e;
    } finally {
      await flush(2000);
    }
  };
};

type ResponseEndMethod = AugmentedResponse['end'];
type WrappedResponseEndMethod = AugmentedResponse['end'];

function wrapEndMethod(origEnd: ResponseEndMethod): WrappedResponseEndMethod {
  return async function newEnd(this: AugmentedResponse, ...args: unknown[]) {
    const transaction = this.__sentryTransaction;

    if (transaction) {
      transaction.setHttpStatus(this.statusCode);

      // Push `transaction.finish` to the next event loop so open spans have a better chance of finishing before the
      // transaction closes, and make sure to wait until that's done before flushing events
      const transactionFinished: Promise<void> = new Promise(resolve => {
        setImmediate(() => {
          transaction.finish();
          resolve();
        });
      });
      await transactionFinished;
    }

    // flush the event queue to ensure that events get sent to Sentry before the response is finished and the lambda
    // ends
    try {
      logger.log('Flushing events...');
      await flush(2000);
      logger.log('Done flushing events');
    } catch (e) {
      logger.log(`Error while flushing events:\n${e}`);
    }

    return origEnd.call(this, ...args);
  };
}
