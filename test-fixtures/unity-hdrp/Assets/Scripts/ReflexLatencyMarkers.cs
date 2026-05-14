using UnityEngine;

public sealed class ReflexLatencyMarkers : MonoBehaviour
{
    // Fixture-only marker names. Static validation must not treat these as measured latency data.
    private void Update()
    {
        var inputSampleBoundary = "Reflex input sample";
        var simulationBoundary = "Reflex simulation";
        var renderSubmitBoundary = "Reflex render submit";
        var presentBoundary = "Reflex present";
        _ = inputSampleBoundary + simulationBoundary + renderSubmitBoundary + presentBoundary;
    }
}
