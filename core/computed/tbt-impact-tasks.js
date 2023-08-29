/**
 * @license Copyright 2023 The Lighthouse Authors. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */

import {makeComputedArtifact} from './computed-artifact.js';
import {MainThreadTasks} from './main-thread-tasks.js';
import {FirstContentfulPaint} from './metrics/first-contentful-paint.js';
import {Interactive} from './metrics/interactive.js';
import {TotalBlockingTime} from './metrics/total-blocking-time.js';
import {ProcessedTrace} from './processed-trace.js';
import {calculateTbtImpactForEvent} from './metrics/tbt-utils.js';

class TBTImpactTasks {
  /**
   * @param {LH.Artifacts.TaskNode} task
   * @return {LH.Artifacts.TaskNode}
   */
  static getTopLevelTask(task) {
    let topLevelTask = task;
    while (topLevelTask.parent) {
      topLevelTask = topLevelTask.parent;
    }
    return topLevelTask;
  }

  /**
   * @param {LH.Artifacts.MetricComputationDataInput} metricComputationData
   * @param {LH.Artifacts.ComputedContext} context
   * @return {Promise<{startTimeMs: number, endTimeMs: number}>}
   */
  static async getTbtBounds(metricComputationData, context) {
    const processedTrace = await ProcessedTrace.request(metricComputationData.trace, context);
    if (metricComputationData.gatherContext.gatherMode !== 'navigation') {
      return {
        startTimeMs: 0,
        endTimeMs: processedTrace.timings.traceEnd,
      };
    }

    const fcpResult = await FirstContentfulPaint.request(metricComputationData, context);
    const ttiResult = await Interactive.request(metricComputationData, context);

    let startTimeMs = fcpResult.timing;
    let endTimeMs = ttiResult.timing;

    // When using lantern, we want to get a pessimistic view of the long tasks.
    // This means we assume the earliest possible start time and latest possible end time.

    if ('optimisticEstimate' in fcpResult) {
      startTimeMs = fcpResult.optimisticEstimate.timeInMs;
    }

    if ('pessimisticEstimate' in ttiResult) {
      endTimeMs = ttiResult.pessimisticEstimate.timeInMs;
    }

    return {startTimeMs, endTimeMs};
  }

  /**
   * @param {LH.Artifacts.TaskNode[]} tasks
   * @param {Map<LH.Artifacts.TaskNode, number>} taskToImpact
   */
  static createImpactTasks(tasks, taskToImpact) {
    /** @type {LH.Artifacts.TBTImpactTask[]} */
    const tbtImpactTasks = [];

    for (const task of tasks) {
      const tbtImpact = taskToImpact.get(task) || 0;
      let selfTbtImpact = tbtImpact;

      for (const child of task.children) {
        const childTbtImpact = taskToImpact.get(child) || 0;
        selfTbtImpact -= childTbtImpact;
      }

      tbtImpactTasks.push({
        ...task,
        tbtImpact,
        selfTbtImpact,
      });
    }

    return tbtImpactTasks;
  }

  /**
   * @param {LH.Artifacts.TaskNode[]} tasks
   * @param {number} startTimeMs
   * @param {number} endTimeMs
   * @return {LH.Artifacts.TBTImpactTask[]}
   */
  static computeImpactsFromObservedTasks(tasks, startTimeMs, endTimeMs) {
    /** @type {Map<LH.Artifacts.TaskNode, number>} */
    const taskToImpact = new Map();

    for (const task of tasks) {
      const event = {
        start: task.startTime,
        end: task.endTime,
        duration: task.duration,
      };

      const topLevelTask = this.getTopLevelTask(task);
      const topLevelEvent = {
        start: topLevelTask.startTime,
        end: topLevelTask.endTime,
        duration: topLevelTask.duration,
      };

      const tbtImpact = calculateTbtImpactForEvent(event, startTimeMs, endTimeMs, topLevelEvent);

      taskToImpact.set(task, tbtImpact);
    }

    return this.createImpactTasks(tasks, taskToImpact);
  }

  /**
   * @param {LH.Artifacts.TaskNode[]} tasks
   * @param {LH.Gatherer.Simulation.Result['nodeTimings']} tbtNodeTimings
   * @param {number} startTimeMs
   * @param {number} endTimeMs
   * @return {LH.Artifacts.TBTImpactTask[]}
   */
  static computeImpactsFromLantern(tasks, tbtNodeTimings, startTimeMs, endTimeMs) {
    /** @type {Map<LH.Artifacts.TaskNode, number>} */
    const taskToImpact = new Map();

    /** @type {Map<LH.Artifacts.TaskNode, {start: number, end: number, duration: number}>} */
    const topLevelTaskToEvent = new Map();

    /** @type {Map<LH.TraceEvent, LH.Artifacts.TaskNode>} */
    const traceEventToTask = new Map();
    for (const task of tasks) {
      traceEventToTask.set(task.event, task);
    }

    // Use lantern TBT timings to calculate the TBT impact of top level tasks.
    for (const [node, timing] of tbtNodeTimings) {
      if (node.type !== 'cpu') continue;

      const event = {
        start: timing.startTime,
        end: timing.endTime,
        duration: timing.duration,
      };

      const tbtImpact = calculateTbtImpactForEvent(event, startTimeMs, endTimeMs);

      const task = traceEventToTask.get(node.event);
      if (!task) continue;

      topLevelTaskToEvent.set(task, event);
      taskToImpact.set(task, tbtImpact);
    }

    // Interpolate the TBT impact of remaining tasks using the top level ancestor tasks.
    // We don't have any lantern estimates for tasks that are not top level, so we need to estimate
    // the lantern timing based on the task's observed timing relative to it's top level task's observed timing.
    for (const task of tasks) {
      if (taskToImpact.has(task)) continue;

      const topLevelTask = this.getTopLevelTask(task);

      const topLevelEvent = topLevelTaskToEvent.get(topLevelTask);
      if (!topLevelEvent) continue;

      const startRatio = (task.startTime - topLevelTask.startTime) / topLevelTask.duration;
      const start = startRatio * topLevelEvent.duration + topLevelEvent.start;

      const endRatio = (topLevelTask.endTime - task.endTime) / topLevelTask.duration;
      const end = topLevelEvent.end - endRatio * topLevelEvent.duration;

      const event = {
        start,
        end,
        duration: end - start,
      };

      const tbtImpact = calculateTbtImpactForEvent(event, startTimeMs, endTimeMs, topLevelEvent);

      taskToImpact.set(task, tbtImpact);
    }

    return this.createImpactTasks(tasks, taskToImpact);
  }

  /**
   * @param {LH.Artifacts.MetricComputationDataInput} metricComputationData
   * @param {LH.Artifacts.ComputedContext} context
   * @return {Promise<LH.Artifacts.TBTImpactTask[]>}
   */
  static async compute_(metricComputationData, context) {
    const tbtResult = await TotalBlockingTime.request(metricComputationData, context);
    const tasks = await MainThreadTasks.request(metricComputationData.trace, context);

    const {startTimeMs, endTimeMs} = await this.getTbtBounds(metricComputationData, context);

    if ('pessimisticEstimate' in tbtResult) {
      return this.computeImpactsFromLantern(
        tasks,
        tbtResult.pessimisticEstimate.nodeTimings,
        startTimeMs,
        endTimeMs
      );
    }

    return this.computeImpactsFromObservedTasks(tasks, startTimeMs, endTimeMs);
  }
}

const TBTImpactTasksComputed = makeComputedArtifact(
  TBTImpactTasks,
  ['trace', 'devtoolsLog', 'URL', 'gatherContext', 'settings', 'simulator']
);
export {TBTImpactTasksComputed as TBTImpactTasks};