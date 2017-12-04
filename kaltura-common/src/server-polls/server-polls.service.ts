import { Observable } from 'rxjs/Observable';
import { Subscriber } from 'rxjs/Subscriber';
import { FriendlyHashId } from '../friendly-hash-id';
import { ISubscription } from 'rxjs/Subscription';
import { Subject } from 'rxjs/Subject';

export type PollInterval = 10 | 30 | 60 | 300;

export interface RequestFactory<T> {
  create(): T;
}

interface PollItem<TRequest> {
  id: string;
  interval: PollInterval;
  lastExecution: Date,
  requestFactory: RequestFactory<TRequest>,
  observer: Subscriber<any>
}

export abstract class ServerPolls<TRequest, TError> {
  private _pollQueue: { [key: string]: PollItem<TRequest> } = {};
  private _tokenGenerator = new FriendlyHashId();
  private _queueTimeout: number;
  private _isInitialized = false;
  private _executionSubscription: ISubscription;
  
  protected abstract _executeRequests(requests: TRequest[]): Observable<{ error: TError, result: any }[]>;
  
  protected abstract _createGlobalError(): TError;
  
  protected abstract _getOnDestroy$(): Observable<void>;
  
  constructor() {
    this._initialize();
  }
  
  private _initialize(): void {
    setTimeout(() => {
      const onDestroy$ = this._getOnDestroy$();
      
      if (!onDestroy$) {
        throw new Error(`calling method '_getOnDestroy$()' didn't return valid observable (did you remember to provide 'Observable' that will be invoked from ngOnDestroy method?) `);
      } else {
        onDestroy$.subscribe(() => {
          this._cancelCurrentInterval();
          if (this._executionSubscription) {
            this._executionSubscription.unsubscribe();
            this._executionSubscription = null;
          }
        });
        
        this._isInitialized = true;
      }
    });
  }
  
  private _cancelCurrentInterval(): void {
    clearTimeout(this._queueTimeout);
  }
  
  private _getPollQueueList(): PollItem<TRequest>[] {
    return Object.keys(this._pollQueue).map(key => this._pollQueue[key]);
  }
  
  // TODO [kmcng] replace this function with log library
  private _log(level: 'silly' | 'debug' | 'info' | 'warn' | 'error', message: string, fileId?: string): void {
    const messageContext = fileId ? `file '${fileId}'` : '';
    const origin = 'server-polls';
    const formattedMessage = `log: [${level}] [${origin}] ${messageContext}: ${message}`;
    switch (level) {
      case 'silly':
      case 'debug':
      case 'info':
        console.log(formattedMessage);
        break;
      case 'warn':
        console.warn(formattedMessage);
        break;
      case 'error':
        console.error(formattedMessage);
        break;
    }
  }
  
  private _runQueue(): void {
    const pollQueueList = this._getPollQueueList();
    if (!pollQueueList.length) {
      this._log('debug', `There's nothing in the queue. Waiting for subscribers...`);
      this._cancelCurrentInterval();
      return;
    }
    
    this._cancelCurrentInterval();
    
    let interval = 10; // default interval
    if (pollQueueList.some(({ lastExecution }) => !!lastExecution)) {
      interval = Math.min(...pollQueueList.map(({ interval }) => interval)) / 2;
    }
    
    this._queueTimeout = setTimeout(() => {
      this._onTick(() => {
        this._runQueue();
      });
    }, interval * 1000);
  }
  
  private _onTick(runNextTick: () => void): void {
    this._log('info', 'Running next tick');
    
    if (!this._isInitialized) {
      this._log('warn', 'service is disabled due to error during initialization, view error log for more details.');
      return;
    }
    
    const queue = this._getPollQueueList()
      .filter(item => !item.lastExecution || Number(item.lastExecution) + (item.interval * 1000) <= Number(new Date()));
    const requests = queue.map(item => {
      let result;
      let error;
      try {
        result = item.requestFactory.create();
      } catch (err) {
        result = null;
        error = err;
      }
      
      if (!result) {
        try {
          item.observer.next([{ error: error, result: null }]);
        } catch (err) {
          // do nothing
          this._log('warn', 'Error happened during action creation');
        }
      }
      return result;
    }).filter(Boolean);
    
    if (!queue.length) {
      this._log('info', 'Nothing to run. Waiting next tick...');
      runNextTick();
      return;
    }
    
    this._log('info', 'Ask server for data');
    
    this._executionSubscription = this._executeRequests(requests)
      .subscribe(response => {
          queue.forEach((item, index) => {
            try {
              if (this._pollQueue[item.id]) {
                this._log('info', `Received data for: ${item.id}`);
                const currentResponse = Array.isArray(response[index]) ? response[index] : [response[index]];
                item.observer.next(currentResponse);
                item.lastExecution = new Date();
              }
            } catch (err) {
              // do nothing
              this._log('warn', 'Error happened during proceeding response');
            }
          });
          runNextTick();
        },
        (error) => {
          const globalError = this._createGlobalError();
          queue.forEach((item) => {
            if (this._pollQueue[item.id]) {
              item.observer.next([{ error: globalError, result: null }]);
              item.lastExecution = new Date();
            }
          });
          this._log('warn', `Error happened: ${error.message}`);
          runNextTick();
        }
      );
  }
  
  public register(intervalInSeconds: PollInterval, requestFactory: RequestFactory<TRequest>): Observable<{ error: TError, result: any }[]> {
    return Observable.create(observer => {
      const newPollId = this._tokenGenerator.generateUnique(Object.keys(this._pollQueue));
      this._pollQueue[newPollId] = {
        id: newPollId,
        interval: intervalInSeconds,
        lastExecution: null,
        requestFactory: requestFactory,
        observer: observer
      };
      
      this._log('info', `Registering new poll request: ${newPollId}`);
      this._log('info', 'Starting new interval');
      this._runQueue();
      
      return () => {
        this._log('info', `Stop polling for ${newPollId}`);
        delete this._pollQueue[newPollId];
      }
    });
  }
}