/**
 * Copyright 2013-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule ReactFiberCommitWork
 * @flow
 */

'use strict';

import type { Fiber } from 'ReactFiber';
import type { FiberRoot } from 'ReactFiberRoot';
import type { HostConfig } from 'ReactFiberReconciler';

var ReactTypeOfWork = require('ReactTypeOfWork');
var {
  ClassComponent,
  HostContainer,
  HostComponent,
  HostText,
} = ReactTypeOfWork;
var { callCallbacks } = require('ReactFiberUpdateQueue');

var {
  Placement,
  Update,
  Callback,
} = require('ReactTypeOfSideEffect');

module.exports = function<T, P, I, TI, C>(
  config : HostConfig<T, P, I, TI, C>,
  trapError : (failedFiber : Fiber, error: Error, isUnmounting : boolean) => void
) {

  const updateContainer = config.updateContainer;
  const commitUpdate = config.commitUpdate;
  const commitTextUpdate = config.commitTextUpdate;

  const appendChild = config.appendChild;
  const insertBefore = config.insertBefore;
  const removeChild = config.removeChild;

  function detachRef(current : Fiber) {
    const ref = current.ref;
    if (ref) {
      ref(null);
    }
  }

  function detachRefIfNeeded(current : ?Fiber, finishedWork : Fiber) {
    if (current) {
      const currentRef = current.ref;
      if (currentRef && currentRef !== finishedWork.ref) {
        currentRef(null);
      }
    }
  }

  function attachRef(current : ?Fiber, finishedWork : Fiber, instance : any) {
    const ref = finishedWork.ref;
    if (ref && (!current || current.ref !== ref)) {
      ref(instance);
    }
  }

  function getHostParent(fiber : Fiber) : ?I {
    let parent = fiber.return;
    while (parent) {
      switch (parent.tag) {
        case HostComponent:
          return parent.stateNode;
        case HostContainer:
          // TODO: Currently we use the updateContainer feature to update these,
          // but we should be able to handle this case too.
          return null;
      }
      parent = parent.return;
    }
    return null;
  }

  function getHostSibling(fiber : Fiber) : ?I {
    // We're going to search forward into the tree until we find a sibling host
    // node. Unfortunately, if multiple insertions are done in a row we have to
    // search past them. This leads to exponential search for the next sibling.
    // TODO: Find a more efficient way to do this.
    let node : Fiber = fiber;
    siblings: while (true) {
      // If we didn't find anything, let's try the next sibling.
      while (!node.sibling) {
        if (!node.return || node.return.tag === HostComponent) {
          // If we pop out of the root or hit the parent the fiber we are the
          // last sibling.
          return null;
        }
        node = node.return;
      }
      node = node.sibling;
      while (node.tag !== HostComponent && node.tag !== HostText) {
        // If it is not host node and, we might have a host node inside it.
        // Try to search down until we find one.
        // TODO: For coroutines, this will have to search the stateNode.
        if (node.effectTag & Placement) {
          // If we don't have a child, try the siblings instead.
          continue siblings;
        }
        if (!node.child) {
          continue siblings;
        } else {
          node = node.child;
        }
      }
      // Check if this host node is stable or about to be placed.
      if (!(node.effectTag & Placement)) {
        // Found it!
        return node.stateNode;
      }
    }
  }

  function commitInsertion(finishedWork : Fiber) : void {
    // Recursively insert all host nodes into the parent.
    const parent = getHostParent(finishedWork);
    if (!parent) {
      return;
    }
    const before = getHostSibling(finishedWork);
    // We only have the top Fiber that was inserted but we need recurse down its
    // children to find all the terminal nodes.
    let node : Fiber = finishedWork;
    while (true) {
      if (node.tag === HostComponent || node.tag === HostText) {
        if (before) {
          insertBefore(parent, node.stateNode, before);
        } else {
          appendChild(parent, node.stateNode);
        }
      } else if (node.child) {
        // TODO: Coroutines need to visit the stateNode.
        node = node.child;
        continue;
      }
      if (node === finishedWork) {
        return;
      }
      while (!node.sibling) {
        if (!node.return || node.return === finishedWork) {
          return;
        }
        node = node.return;
      }
      node = node.sibling;
    }
  }

  function commitNestedUnmounts(root : Fiber): void {
    // While we're inside a removed host node we don't want to call
    // removeChild on the inner nodes because they're removed by the top
    // call anyway. We also want to call componentWillUnmount on all
    // composites before this host node is removed from the tree. Therefore
    // we do an inner loop while we're still inside the host node.
    let node : Fiber = root;
    while (true) {
      commitUnmount(node);
      if (node.child) {
        // TODO: Coroutines need to visit the stateNode.
        node = node.child;
        continue;
      }
      if (node === root) {
        return;
      }
      while (!node.sibling) {
        if (!node.return || node.return === root) {
          return;
        }
        node = node.return;
      }
      node = node.sibling;
    }
  }

  function unmountHostComponents(parent, current): void {
    // We only have the top Fiber that was inserted but we need recurse down its
    // children to find all the terminal nodes.
    let node : Fiber = current;
    while (true) {
      if (node.tag === HostComponent || node.tag === HostText) {
        commitNestedUnmounts(node);
        // After all the children have unmounted, it is now safe to remove the
        // node from the tree.
        if (parent) {
          removeChild(parent, node.stateNode);
        }
      } else {
        commitUnmount(node);
        if (node.child) {
          // TODO: Coroutines need to visit the stateNode.
          node = node.child;
          continue;
        }
      }
      if (node === current) {
        return;
      }
      while (!node.sibling) {
        if (!node.return || node.return === current) {
          return;
        }
        node = node.return;
      }
      node = node.sibling;
    }
  }

  function commitDeletion(current : Fiber) : void {
    // Recursively delete all host nodes from the parent.
    const parent = getHostParent(current);
    // Detach refs and call componentWillUnmount() on the whole subtree.
    unmountHostComponents(parent, current);

    // Cut off the return pointers to disconnect it from the tree. Ideally, we
    // should clear the child pointer of the parent alternate to let this
    // get GC:ed but we don't know which for sure which parent is the current
    // one so we'll settle for GC:ing the subtree of this child. This child
    // itself will be GC:ed when the parent updates the next time.
    current.return = null;
    current.child = null;
    if (current.alternate) {
      current.alternate.child = null;
      current.alternate.return = null;
    }
  }

  function commitUnmount(current : Fiber) : void {
    switch (current.tag) {
      case ClassComponent: {
        detachRef(current);
        const instance = current.stateNode;
        if (typeof instance.componentWillUnmount === 'function') {
          const error = tryCallComponentWillUnmount(instance);
          if (error) {
            trapError(current, error, true);
          }
        }
        return;
      }
      case HostComponent: {
        detachRef(current);
        return;
      }
    }
  }

  function commitWork(current : ?Fiber, finishedWork : Fiber) : void {
    switch (finishedWork.tag) {
      case ClassComponent: {
        detachRefIfNeeded(current, finishedWork);
        return;
      }
      case HostContainer: {
        // TODO: Attach children to root container.
        const children = finishedWork.output;
        const root : FiberRoot = finishedWork.stateNode;
        const containerInfo : C = root.containerInfo;
        updateContainer(containerInfo, children);
        return;
      }
      case HostComponent: {
        const instance : I = finishedWork.stateNode;
        if (instance != null && current) {
          // Commit the work prepared earlier.
          const newProps = finishedWork.memoizedProps;
          const oldProps = current.memoizedProps;
          commitUpdate(instance, oldProps, newProps);
        }
        detachRefIfNeeded(current, finishedWork);
        return;
      }
      case HostText: {
        if (finishedWork.stateNode == null || !current) {
          throw new Error('This should only be done during updates.');
        }
        const textInstance : TI = finishedWork.stateNode;
        const newText : string = finishedWork.memoizedProps;
        const oldText : string = current.memoizedProps;
        commitTextUpdate(textInstance, oldText, newText);
        return;
      }
      default:
        throw new Error('This unit of work tag should not have side-effects.');
    }
  }

  function commitLifeCycles(current : ?Fiber, finishedWork : Fiber) : void {
    switch (finishedWork.tag) {
      case ClassComponent: {
        const instance = finishedWork.stateNode;
        let error = null;
        if (finishedWork.effectTag & Update) {
          if (!current) {
            if (typeof instance.componentDidMount === 'function') {
              error = tryCallComponentDidMount(instance);
            }
          } else {
            if (typeof instance.componentDidUpdate === 'function') {
              const prevProps = current.memoizedProps;
              const prevState = current.memoizedState;
              error = tryCallComponentDidUpdate(instance, prevProps, prevState);
            }
          }
          attachRef(current, finishedWork, instance);
        }
        // Clear updates from current fiber.
        if (finishedWork.alternate) {
          finishedWork.alternate.updateQueue = null;
        }
        if (finishedWork.effectTag & Callback) {
          if (finishedWork.callbackList) {
            callCallbacks(finishedWork.callbackList, instance);
            finishedWork.callbackList = null;
          }
        }
        if (error) {
          trapError(finishedWork, error, false);
        }
        return;
      }
      case HostContainer: {
        const rootFiber = finishedWork.stateNode;
        if (rootFiber.callbackList) {
          const { callbackList } = rootFiber;
          rootFiber.callbackList = null;
          callCallbacks(callbackList, rootFiber.current.child.stateNode);
        }
        return;
      }
      case HostComponent: {
        const instance : I = finishedWork.stateNode;
        attachRef(current, finishedWork, instance);
        return;
      }
      case HostText: {
        // We have no life-cycles associated with text.
        return;
      }
      default:
        throw new Error('This unit of work tag should not have side-effects.');
    }
  }

  function tryCallComponentDidMount(instance) {
    try {
      instance.componentDidMount();
      return null;
    } catch (error) {
      return error;
    }
  }

  function tryCallComponentDidUpdate(instance, prevProps, prevState) {
    try {
      instance.componentDidUpdate(prevProps, prevState);
      return null;
    } catch (error) {
      return error;
    }
  }

  function tryCallComponentWillUnmount(instance) {
    try {
      instance.componentWillUnmount();
      return null;
    } catch (error) {
      return error;
    }
  }

  return {
    commitInsertion,
    commitDeletion,
    commitWork,
    commitLifeCycles,
  };

};
