using WebfrontCore.Core;
using WebfrontCore.Core.Services;

namespace WebfrontCore.Components.UI.Controls;

public partial class ToastContainer
{
    private readonly List<ToastMessage> _messages = [];

    protected override void OnInitialized()
    {
        ToastService.OnShow += ShowToast;
    }

    private void ShowToast(ToastMessage message)
    {
        _messages.Add(message);
        SafeRender.Queue(() => InvokeAsync(StateHasChanged));
    }

    private void Remove(ToastMessage message)
    {
        _messages.Remove(message);
        SafeRender.Queue(() => InvokeAsync(StateHasChanged));
    }

    public void Dispose()
    {
        ToastService.OnShow -= ShowToast;
    }
}
