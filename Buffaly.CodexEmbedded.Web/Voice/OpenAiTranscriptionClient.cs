using System.Net.Http.Headers;
using System.Text.Json;
using System.Text.RegularExpressions;

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
		string? language,
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

		try
		{
			var client = _httpClientFactory.CreateClient();
			var modelCandidates = BuildModelCandidates(model);
			OpenAiTranscriptionException? lastError = null;
			for (var i = 0; i < modelCandidates.Count; i += 1)
			{
				var candidate = modelCandidates[i];
				try
				{
					return await TranscribeWithModelAsync(
						client,
						apiKey,
						audioBytes,
						fileName,
						contentType,
						candidate,
						language,
						cancellationToken);
				}
				catch (OpenAiTranscriptionException ex)
				{
					lastError = ex;
					if (i >= modelCandidates.Count - 1 || !ShouldTryFallbackModel(ex))
					{
						throw;
					}
				}
			}

			if (lastError is not null)
			{
				throw lastError;
			}

			throw new OpenAiTranscriptionException(0, "OpenAI transcription failed with no response.");
		}
		catch (HttpRequestException ex)
		{
			throw new OpenAiTranscriptionException(0, $"OpenAI transcription request failed: {ex.Message}");
		}
		catch (TaskCanceledException ex) when (!cancellationToken.IsCancellationRequested)
		{
			throw new OpenAiTranscriptionException(0, $"OpenAI transcription request timed out: {ex.Message}");
		}
	}

	private static IReadOnlyList<string> BuildModelCandidates(string? preferredModel)
	{
		var candidates = new List<string>();
		void AddCandidate(string? value)
		{
			var normalized = string.IsNullOrWhiteSpace(value) ? string.Empty : value.Trim();
			if (string.IsNullOrWhiteSpace(normalized))
			{
				return;
			}

			if (!candidates.Contains(normalized, StringComparer.OrdinalIgnoreCase))
			{
				candidates.Add(normalized);
			}
		}

		AddCandidate(preferredModel);
		AddCandidate("gpt-4o-mini-transcribe");
		AddCandidate("gpt-4o-transcribe");
		AddCandidate("whisper-1");
		return candidates;
	}

	private static bool ShouldTryFallbackModel(OpenAiTranscriptionException ex)
	{
		if (ex is null)
		{
			return false;
		}

		if (ex.StatusCode != 400 && ex.StatusCode != 404)
		{
			return false;
		}

		var message = (ex.Message ?? string.Empty).ToLowerInvariant();
		if (!message.Contains("model"))
		{
			return false;
		}

		return message.Contains("not found")
			|| message.Contains("does not exist")
			|| message.Contains("not available")
			|| message.Contains("invalid model")
			|| message.Contains("unknown model")
			|| message.Contains("unsupported model")
			|| message.Contains("do not have access");
	}

	private static async Task<string> TranscribeWithModelAsync(
		HttpClient client,
		string apiKey,
		byte[] audioBytes,
		string? fileName,
		string? contentType,
		string model,
		string? language,
		CancellationToken cancellationToken)
	{
		using var request = new HttpRequestMessage(HttpMethod.Post, "https://api.openai.com/v1/audio/transcriptions");
		request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", apiKey.Trim());

		using var form = new MultipartFormDataContent();
		var safeName = string.IsNullOrWhiteSpace(fileName) ? "audio.webm" : fileName.Trim();
		var safeContentType = string.IsNullOrWhiteSpace(contentType) ? "application/octet-stream" : contentType.Trim();
		var safeModel = string.IsNullOrWhiteSpace(model) ? "gpt-4o-mini-transcribe" : model.Trim();

		var audioContent = new ByteArrayContent(audioBytes);
		if (!MediaTypeHeaderValue.TryParse(safeContentType, out var parsedContentType) || parsedContentType is null)
		{
			parsedContentType = new MediaTypeHeaderValue("application/octet-stream");
		}

		audioContent.Headers.ContentType = parsedContentType;
		form.Add(audioContent, "file", safeName);
		form.Add(new StringContent(safeModel), "model");
		var safeLanguage = NormalizeLanguage(language);
		if (!string.IsNullOrWhiteSpace(safeLanguage))
		{
			form.Add(new StringContent(safeLanguage), "language");
		}
		request.Content = form;

		using var response = await client.SendAsync(request, cancellationToken);
		var raw = await response.Content.ReadAsStringAsync(cancellationToken);
		if (!response.IsSuccessStatusCode)
		{
			throw new OpenAiTranscriptionException(
				(int)response.StatusCode,
				BuildFailureMessage((int)response.StatusCode, safeModel, raw));
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

	private static string NormalizeLanguage(string? language)
	{
		var candidate = string.IsNullOrWhiteSpace(language)
			? string.Empty
			: language.Trim().ToLowerInvariant();
		if (string.IsNullOrWhiteSpace(candidate))
		{
			return string.Empty;
		}

		return Regex.IsMatch(candidate, "^[a-z]{2,3}(-[a-z]{2})?$", RegexOptions.CultureInvariant)
			? candidate
			: string.Empty;
	}

	private static string BuildFailureMessage(int statusCode, string model, string body)
	{
		var safeBody = string.IsNullOrWhiteSpace(body)
			? string.Empty
			: (body.Length > 500 ? body[..500] + "..." : body);
		return $"OpenAI transcription failed with status {statusCode} (model={model}).{(string.IsNullOrWhiteSpace(safeBody) ? string.Empty : $" Body: {safeBody}")}";
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
