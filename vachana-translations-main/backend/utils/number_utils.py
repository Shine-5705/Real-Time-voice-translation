def update_numbers(text: str, lang: str) -> str:
    if lang == "hi":
        return update_numbers_to_hindi(text)
    elif lang == "ta":
        return update_number_to_tamil(text)
    elif lang == "ml":
        return update_numbers_to_malayalam(text)
    
    return text

def update_number_to_tamil(text: str) -> str:
    return (
        text.replace("1", "௧")
        .replace("2", "௨")
        .replace("3", "௩")
        .replace("4", "௪")
        .replace("5", "௫")
        .replace("6", "௬")
        .replace("7", "௭")
        .replace("8", "௮")
        .replace("9", "௯")
        .replace("0", "௦")
    )

def update_numbers_to_hindi(text: str) -> str:
    return (
        text.replace("1", "१")
        .replace("2", "२")
        .replace("3", "३")
        .replace("4", "४")
        .replace("5", "५")
        .replace("6", "६")
        .replace("7", "७")
        .replace("8", "८")
        .replace("9", "९")
        .replace("0", "०")
    )

def update_numbers_to_malayalam(text: str) -> str:
    return (
        text.replace("1", "൧")
        .replace("2", "൨")
        .replace("3", "൩")
        .replace("4", "൪")
        .replace("5", "൫")
        .replace("6", "൬")
        .replace("7", "൭")
        .replace("8", "൮")
        .replace("9", "൯")
        .replace("0", "൦")
    )
