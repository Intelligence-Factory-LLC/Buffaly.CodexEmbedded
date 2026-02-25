using System.Net.Http.Headers;
using System.Text.Json;

internal sealed class OpenAiTranscriptionClient
{
	private readonly IHttpClientFactory _httpClientFactory;

	public OpenAiTranscriptionClient(IHttpClientFactory httpClientFactory)
	{
		_httpClientFactory = httpClientFactory;
	}

	public async Task<string> TranscribeAsync(
		string apiKey,
		byte[] audioBytes,
		string? fileName,
		string? contentType,
		string model,
		CancellationToken cancellationToken)
	{
		if (string.IsNullOrWhiteSpace(apiKey))
		{
			throw new InvalidOperationException("OpenAI API key is required.");
		}
		if (audioBytes is null || audioBytes.Length <= 0)
		{
			throw new InvalidOperationException("Audio payload is required.");
		}

		var client = _httpClientFactory.CreateClient();
		using var request = new HttpRequestMessage(HttpMethod.Post, "https://api.openai.com/v1/audio/transcriptions");
		request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey.Trim());

		using var form = new MultipartFormDataContent();
		var safeName = string.IsNullOrWhiteSpace(fileName) ? "audio.webm" : fileName.Trim();
		var safeContentType = string.IsNullOrWhiteSpace(contentType) ? "application/octet-stream" : contentType.Trim();
		var safeModel = string.IsNullOrWhiteSpace(model) ? "whisper-1" : model.Trim();

		var audioContent = new ByteArrayContent(audioBytes);
		audioContent.Headers.ContentType = new MediaTypeHeaderValue(safeContentType);
		form.Add(audioContent, "file", safeName);
		form.Add(new StringContent(safeModel), "model");
		request.Content = form;

		using var response = await client.SendAsync(request, cancellationToken);
		var raw = await response.Content.ReadAsStringAsync(cancellationToken);
		if (!response.IsSuccessStatusCode)
		{
			throw new OpenAiTranscriptionException((int)response.StatusCode, BuildFailureMessage((int)response.StatusCode, raw));
		}

		try
		{
			using var doc = JsonDocument.Parse(raw);
			var root = doc.RootElement;
			if (root.TryGetProperty("text", out var textElement) && textElement.ValueKind == JsonValueKind.String)
			{
				return textElement.GetString() ?? string.Empty;
			}
		}
		catch (JsonException)
		{
		}

		return string.Empty;
	}

	private static string BuildFailureMessage(int statusCode, string body)
	{
		var safeBody = string.IsNullOrWhiteSpace(body)
			? string.Empty
			: (body.Length > 500 ? body[..500] + "..." : body);
		return $"OpenAI transcription failed with status {statusCode}.{(string.IsNullOrWhiteSpace(safeBody) ? string.Empty : $" Body: {safeBody}")}";
	}
}

internal sealed class OpenAiTranscriptionException : Exception
{
	public int StatusCode { get; }

	public OpenAiTranscriptionException(int statusCode, string message) : base(message)
	{
		StatusCode = statusCode;
	}
}
