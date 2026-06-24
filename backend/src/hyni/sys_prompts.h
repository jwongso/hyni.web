#ifndef HYNI_SYS_PROMPTS_H
#define HYNI_SYS_PROMPTS_H

#include <string>
#include "types.h"

namespace hyni {

// Persistent identity context supplied by the frontend (sourced from the
// Settings page). All fields optional; empty fields are omitted from the
// composed system prompt.
struct user_profile {
    std::string resume_text;       // pasted or parsed CV
    std::string target_role;       // role title plus optional full job description
    std::string extra_notes;       // anything else — strengths, weaknesses, motivations, comp, ...
};

// Build the system prompt for a given mode + user profile.
// Defaults are opinionated to reduce hallucination:
//   - General:    concise, interview-appropriate.
//   - Coding:     Python by default unless prompt names a language.
//   - Behavioral: strict STAR, grounded only in user_profile.resume_text.
std::string compose_system_prompt(QUESTION_TYPE mode, const user_profile& profile);

} // namespace hyni

#endif // HYNI_SYS_PROMPTS_H
