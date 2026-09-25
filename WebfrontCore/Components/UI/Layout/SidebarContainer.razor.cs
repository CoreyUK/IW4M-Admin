using WebfrontCore.Core;

namespace WebfrontCore.Components.UI.Layout;

public partial class SidebarContainer
{
    protected override void OnInitialized()
    {
        AppState.OnChange += OnAppStateChange;
    }

    // AppState is updated by background polls, so this can arrive on any thread.
    private void OnAppStateChange()
    {
        SafeRender.Queue(() => InvokeAsync(StateHasChanged));
    }

    public void Dispose()
    {
        AppState.OnChange -= OnAppStateChange;
    }

    private void ToggleMobile()
    {
        AppState.IsMobileNavOpen = false;
    }
}