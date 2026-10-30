import { registerRootComponent } from "expo"
import * as TaskManager from "expo-task-manager"
import * as BackgroundTask from "expo-background-task"
import App from "./App"
import { AGENT_ACTIVITY_TASK, checkAgentActivityInBackground } from "./src/background-notifications"

// WorkManager/BGTaskScheduler entry point: must live in the global scope of
// an early-required module so the OS can wake the bundle without the UI.
TaskManager.defineTask(AGENT_ACTIVITY_TASK, async () => {
  try {
    await checkAgentActivityInBackground()
    return BackgroundTask.BackgroundTaskResult.Success
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed
  }
})

registerRootComponent(App)
