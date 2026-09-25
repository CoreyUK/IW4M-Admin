namespace WebfrontCore.Core;

/// <summary>
///     Queues a re-render from code that is not already on the renderer's dispatcher, such as an
///     AppState change raised by a background poll.
///     <para>
///         Two things go wrong without it. Calling <c>StateHasChanged</c> straight from an event
///         handler renders on whichever thread raised the event, which Blazor does not allow.
///         Dispatching it and then dropping the returned task is no better: a circuit torn down
///         between the notification and the render faults that task, nobody observes it, and it
///         resurfaces much later as an <c>AggregateException</c> on the finalizer thread, logged
///         with a stack that points at the render tree rather than at whatever queued the render.
///     </para>
///     <para>
///         A render losing its circuit is normal - somebody closed a tab - so the fault is
///         swallowed rather than logged.
///     </para>
/// </summary>
public static class SafeRender
{
    /// <summary>
    ///     Runs <paramref name="render" /> on the renderer's dispatcher, ignoring the circuit
    ///     going away underneath it.
    /// </summary>
    /// <param name="render">Usually <c>() =&gt; InvokeAsync(StateHasChanged)</c>.</param>
    public static void Queue(Func<Task> render)
    {
        Task task;

        try
        {
            task = render();
        }
        catch (ObjectDisposedException)
        {
            return;
        }
        catch (InvalidOperationException)
        {
            // The renderer is shutting down and will not accept more work.
            return;
        }

        if (task.IsCompletedSuccessfully)
        {
            return;
        }

        // Touching Exception is what marks the task observed.
        task.ContinueWith(static faulted => _ = faulted.Exception,
            CancellationToken.None,
            TaskContinuationOptions.OnlyOnFaulted | TaskContinuationOptions.ExecuteSynchronously,
            TaskScheduler.Default);
    }
}
