using Envmux.Agents;
using Envmux.Config;

namespace Envmux.Tests;

public sealed class ProjectSkillsTests
{
    [Fact]
    public async Task InstallsBothAndPreservesCustomizedSkills()
    {
        var directory = Path.Combine(Path.GetTempPath(), $"envmux-skills-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            await ProjectSkills.InstallAsync(directory, "both");
            foreach (var root in new[] { ".claude", ".agents" })
            {
                foreach (var skill in new[] { "envmux-setup", "envmux-chef", "envmux-delegate" })
                {
                    Assert.True(File.Exists(Path.Combine(directory, root, "skills", skill, "SKILL.md")));
                }
            }

            await ProjectSkills.InstallAsync(directory, "both");
            var customized = Path.Combine(directory, ".agents", "skills", "envmux-setup", "SKILL.md");
            await File.WriteAllTextAsync(customized, "custom instructions");
            var missing = Path.Combine(directory, ".claude", "skills", "envmux-chef", "SKILL.md");
            File.Delete(missing);
            await Assert.ThrowsAsync<ConfigException>(() => ProjectSkills.InstallAsync(directory, "both"));
            Assert.Equal("custom instructions", await File.ReadAllTextAsync(customized));
            Assert.False(File.Exists(missing));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }
}
