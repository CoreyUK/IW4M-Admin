using WebfrontCore.Core;

namespace WebfrontCore.Components.Features.Search.Components;

public partial class AdvancedSearchModal
{
    private string _searchType = "client";

    protected override void OnInitialized()
    {
        AppState.OnChange += OnAppStateChanged;
    }

    public void Dispose()
    {
        AppState.OnChange -= OnAppStateChanged;
    }

    // AppState is updated by background polls, so this can arrive on any thread.
    private void OnAppStateChanged() => SafeRender.Queue(() => InvokeAsync(StateHasChanged));

    private void Close()
    {
        AppState.IsAdvancedSearchOpen = false;
    }

    private string GetTabClass(string tabType)
    {
        var baseClass = "flex-1 px-3 py-2 text-sm font-medium transition-colors focus:outline-none ";
        if (_searchType == tabType)
        {
            return baseClass + "text-primary border-b-2 border-primary -mb-px";
        }

        return baseClass + "text-muted hover:text-foreground";
    }
}